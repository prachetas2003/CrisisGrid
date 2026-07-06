import { createHash } from "node:crypto";
import { polygonCentroid, type Db, type ScenarioEngine } from "@crisisgrid/engine";
import { fetchOpenMeteoForecast, type LiveForecastPeriod } from "@crisisgrid/mcp-server";
import type { SourceMetadata, ZoneFeature } from "@crisisgrid/shared";
import { runtimeSnapshot } from "../routes/runtime.js";

const WEATHER_DOMAIN = "weather.forecast";
const WEATHER_PROVIDER = "Open-Meteo";
const WEATHER_TTL_MS = 30 * 60 * 1000;

export interface ProviderRefreshResult {
  refreshed: boolean;
  mode: "demo" | "live";
  providers: Array<{
    domain: string;
    provider: string;
    status: "fresh" | "stale" | "fallback" | "error" | "unknown";
    source: "live" | "scenario" | "manual" | "synthetic";
    asOf: string;
    expiresAt: string | null;
    note: string;
  }>;
}

export interface CacheRow {
  domain: string;
  provider: string;
  source: "live" | "scenario" | "manual" | "synthetic";
  as_of: string;
  expires_at: string | null;
  status: "fresh" | "stale" | "fallback" | "error" | "unknown";
  payload_json: string;
}

export async function refreshLiveProviders(
  db: Db,
  engine: ScenarioEngine,
  scenarioId: string,
  options: { force?: boolean } = {},
): Promise<ProviderRefreshResult> {
  const runtime = runtimeSnapshot(db);
  if (runtime.mode !== "live") {
    return { refreshed: false, mode: runtime.mode, providers: [] };
  }

  const existing = latestProviderCache(db, WEATHER_DOMAIN, WEATHER_PROVIDER);
  if (!options.force && existing?.status === "fresh" && existing.expires_at && Date.parse(existing.expires_at) > Date.now()) {
    return {
      refreshed: false,
      mode: "live",
      providers: [providerResult(existing, "Fresh provider cache reused.")],
    };
  }

  const asOf = new Date().toISOString();
  try {
    const [lon, lat] = forecastCoordinate(engine, scenarioId);
    const periods = await fetchOpenMeteoForecast(lat, lon, 12, 3500);
    const expiresAt = new Date(Date.now() + WEATHER_TTL_MS).toISOString();
    const payload = { scenarioId, lat, lon, periods };
    const row = writeProviderCache(db, {
      id: `${WEATHER_DOMAIN}:${WEATHER_PROVIDER}:${scenarioId}`,
      domain: WEATHER_DOMAIN,
      provider: WEATHER_PROVIDER,
      source: "live",
      status: "fresh",
      asOf,
      expiresAt,
      payload,
    });
    return { refreshed: true, mode: "live", providers: [providerResult(row, "Live forecast refreshed.")] };
  } catch (error) {
    const payload = {
      scenarioId,
      error: error instanceof Error ? error.message : String(error),
      fallback: "Scenario weather remains active for map state.",
    };
    const row = writeProviderCache(db, {
      id: `${WEATHER_DOMAIN}:${WEATHER_PROVIDER}:${scenarioId}`,
      domain: WEATHER_DOMAIN,
      provider: WEATHER_PROVIDER,
      source: "live",
      status: "error",
      asOf,
      expiresAt: null,
      payload,
    });
    return { refreshed: true, mode: "live", providers: [providerResult(row, "Live refresh failed; scenario fallback active.")] };
  }
}

export function latestProviderCache(db: Db, domain: string, provider: string): CacheRow | null {
  return (
    (db
      .prepare(
        `SELECT domain, provider, source, as_of, expires_at, status, payload_json
         FROM provider_cache WHERE domain = ? AND provider = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(domain, provider) as CacheRow | undefined) ?? null
  );
}

export function latestProviderCacheByDomain(db: Db, domain: string): CacheRow | null {
  return (
    (db
      .prepare(
        `SELECT domain, provider, source, as_of, expires_at, status, payload_json
         FROM provider_cache WHERE domain = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(domain) as CacheRow | undefined) ?? null
  );
}

export function latestProviderPayload<T>(db: Db, domain: string, provider: string): T | null {
  const row = latestProviderCache(db, domain, provider);
  if (!row) return null;
  return JSON.parse(row.payload_json) as T;
}

export function providerSource(
  db: Db,
  domain: string,
  provider: string,
  fallback: SourceMetadata,
): SourceMetadata {
  const row = latestProviderCache(db, domain, provider);
  if (!row) return fallback;
  if (row.status === "fresh" || row.status === "stale") {
    return {
      source: row.source,
      provider: row.provider,
      asOf: row.as_of,
      freshness: row.status,
      note: `${domain} from provider cache.`,
    };
  }
  const payload = JSON.parse(row.payload_json) as { error?: string; fallback?: string };
  return {
    ...fallback,
    freshness: "fallback",
    note: payload.error
      ? `${provider} unavailable: ${payload.error}. ${payload.fallback ?? "Fallback source active."}`
      : `${provider} unavailable; fallback source active.`,
  };
}

export function providerSourceByDomain(
  db: Db,
  domain: string,
  fallback: SourceMetadata,
): SourceMetadata {
  const row = latestProviderCacheByDomain(db, domain);
  if (!row) return fallback;
  if (row.status === "fresh" || row.status === "stale") {
    return {
      source: row.source,
      provider: row.provider,
      asOf: row.as_of,
      freshness: row.status,
      note: `${domain} from provider cache.`,
    };
  }
  const payload = JSON.parse(row.payload_json) as { error?: string; fallback?: string };
  return {
    ...fallback,
    freshness: "fallback",
    note: payload.error
      ? `${row.provider} unavailable: ${payload.error}. ${payload.fallback ?? "Fallback source active."}`
      : `${row.provider} unavailable; fallback source active.`,
  };
}

export function writeProviderCache(
  db: Db,
  input: {
    id: string;
    domain: string;
    provider: string;
    source: "live" | "scenario" | "manual" | "synthetic";
    status: "fresh" | "stale" | "fallback" | "error" | "unknown";
    asOf: string;
    expiresAt: string | null;
    payload: unknown;
  },
): CacheRow {
  const payloadJson = JSON.stringify(input.payload);
  db.prepare(
    `INSERT OR REPLACE INTO provider_cache
      (id, domain, provider, source, as_of, expires_at, status, payload_json, raw_digest, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.domain,
    input.provider,
    input.source,
    input.asOf,
    input.expiresAt,
    input.status,
    payloadJson,
    createHash("sha256").update(payloadJson).digest("hex"),
    new Date().toISOString(),
  );
  return {
    domain: input.domain,
    provider: input.provider,
    source: input.source,
    as_of: input.asOf,
    expires_at: input.expiresAt,
    status: input.status,
    payload_json: payloadJson,
  };
}

function providerResult(row: CacheRow, note: string): ProviderRefreshResult["providers"][number] {
  return {
    domain: row.domain,
    provider: row.provider,
    status: row.status,
    source: row.source,
    asOf: row.as_of,
    expiresAt: row.expires_at,
    note,
  };
}

function forecastCoordinate(engine: ScenarioEngine, scenarioId: string): [lon: number, lat: number] {
  const city = engine.dataset(scenarioId).city;
  const zones = city.features.filter((feature): feature is ZoneFeature => feature.properties.kind === "zone");
  const zone = zones.find((feature) => feature.properties.zoneId === "Z-05") ?? zones[0];
  if (!zone) return [-122.68, 45.51];
  return polygonCentroid(zone.geometry.coordinates[0]!);
}

export type WeatherForecastPayload = {
  scenarioId: string;
  lat: number;
  lon: number;
  periods: LiveForecastPeriod[];
};
