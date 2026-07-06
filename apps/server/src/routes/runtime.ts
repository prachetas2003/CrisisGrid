import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@crisisgrid/engine";
import { broadcast } from "../sse/bus.js";
import { requireRole } from "../security/auth.js";

export type RuntimeMode = "demo" | "live";

export interface ProviderHealth {
  domain: string;
  provider: string;
  enabled: boolean;
  source: "live" | "scenario" | "manual" | "synthetic";
  freshness: "fresh" | "stale" | "fallback" | "unknown";
  status: "ready" | "disabled" | "planned" | "fallback";
  lastOkAt: string | null;
  lastError: string | null;
  note: string;
}

const RUNTIME_KEY = "runtime";
const DEFAULT_SCENARIO_ID = "westside-cascade";

export function runtimeRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/runtime", async () => runtimeSnapshot(db));

  app.post("/api/runtime/mode", { preHandler: requireRole("admin") }, async (req) => {
    const body = z
      .object({
        mode: z.enum(["demo", "live"]),
        scenarioId: z.string().default(DEFAULT_SCENARIO_ID),
      })
      .parse(req.body);
    writeRuntimeConfig(db, body.mode, body.scenarioId);
    const snapshot = runtimeSnapshot(db);
    broadcast({ type: "runtime.mode_changed", payload: snapshot });
    return snapshot;
  });

  app.get("/api/providers/health", async () => {
    const runtime = runtimeSnapshot(db);
    return {
      mode: runtime.mode,
      providers: runtime.providers,
      generatedAt: new Date().toISOString(),
    };
  });
}

export function runtimeSnapshot(db: Db): {
  mode: RuntimeMode;
  scenarioId: string;
  demoMode: boolean;
  generatedAt: string;
  providers: ProviderHealth[];
  sourcePolicy: string;
} {
  const stored = readRuntimeConfig(db);
  const mode = stored?.mode ?? envMode();
  const scenarioId = stored?.scenarioId ?? activeScenarioId(db);
  const providers = providerHealth(db, mode);
  return {
    mode,
    scenarioId,
    demoMode: mode === "demo",
    generatedAt: new Date().toISOString(),
    providers,
    sourcePolicy:
      "Every displayed value must carry source, provider, asOf, and freshness. Scenario fallback must be visible.",
  };
}

function envMode(): RuntimeMode {
  return (process.env.DEMO_MODE ?? "true").toLowerCase() === "false" ? "live" : "demo";
}

function activeScenarioId(db: Db): string {
  const row = db.prepare("SELECT id FROM scenarios ORDER BY loaded_at DESC LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id ?? DEFAULT_SCENARIO_ID;
}

function readRuntimeConfig(db: Db): { mode: RuntimeMode; scenarioId: string } | null {
  const row = db.prepare("SELECT value_json FROM runtime_config WHERE key = ?").get(RUNTIME_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  return z
    .object({ mode: z.enum(["demo", "live"]), scenarioId: z.string().default(DEFAULT_SCENARIO_ID) })
    .parse(JSON.parse(row.value_json));
}

function writeRuntimeConfig(db: Db, mode: RuntimeMode, scenarioId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO runtime_config (key, value_json, updated_at) VALUES (?, ?, ?)",
  ).run(RUNTIME_KEY, JSON.stringify({ mode, scenarioId }), new Date().toISOString());
}

function providerHealth(db: Db, mode: RuntimeMode): ProviderHealth[] {
  const rows = db
    .prepare("SELECT domain, provider, status, as_of, payload_json FROM provider_cache ORDER BY updated_at DESC")
    .all() as { domain: string; provider: string; status: string; as_of: string; payload_json: string }[];
  const latest = new Map<string, { status: string; asOf: string; error: string | null }>();
  const latestByDomain = new Map<string, { provider: string; status: string; asOf: string; error: string | null }>();
  for (const row of rows) {
    const key = `${row.domain}:${row.provider}`;
    const cache = { status: row.status, asOf: row.as_of, error: cacheError(row.payload_json) };
    if (!latest.has(key)) latest.set(key, cache);
    if (!latestByDomain.has(row.domain)) latestByDomain.set(row.domain, { provider: row.provider, ...cache });
  }

  const weatherLive = mode === "live";
  const weatherCache = latest.get("weather.forecast:Open-Meteo");
  return [
    {
      domain: "weather.forecast",
      provider: "Open-Meteo",
      enabled: weatherLive,
      source: weatherLive ? "live" : "scenario",
      freshness: cacheFreshness(weatherCache, weatherLive),
      status: weatherLive && weatherCache?.status === "error" ? "fallback" : weatherLive ? "ready" : "disabled",
      lastOkAt: weatherCache && weatherCache.status !== "error" ? weatherCache.asOf : null,
      lastError: weatherCache?.error ?? null,
      note: weatherLive
        ? "Live-capable forecast adapter is enabled; failures fall back to scenario weather."
        : "Disabled in demo mode; scenario weather is the active source.",
    },
    {
      domain: "weather.alerts",
      provider: "NWS",
      enabled: false,
      source: "scenario",
      freshness: "unknown",
      status: "planned",
      lastOkAt: null,
      lastError: null,
      note: "Planned live alert adapter. Current alerts are scenario-backed.",
    },
    manualProviderHealth("traffic.closures", latestByDomain, mode, "Validated road closure or corridor imports drive traffic state."),
    manualProviderHealth("grid.outages", latestByDomain, mode, "Validated outage imports drive grid state and affected zones."),
    manualProviderHealth("shelters.status", latestByDomain, mode, "Validated shelter capacity imports drive shelter status."),
    manualProviderHealth("facilities.power", latestByDomain, mode, "Validated facility power imports drive hospital, water, and signal power state."),
  ];
}

function cacheFreshness(row: { status: string; asOf: string } | undefined, enabled: boolean): ProviderHealth["freshness"] {
  if (!enabled) return "fallback";
  if (!row) return "unknown";
  if (row.status === "fresh" || row.status === "stale" || row.status === "fallback") return row.status;
  if (row.status === "error") return "fallback";
  return "unknown";
}

function cacheError(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { error?: string };
    return payload.error ?? null;
  } catch {
    return null;
  }
}

function manualProviderHealth(
  domain: string,
  latestByDomain: Map<string, { provider: string; status: string; asOf: string; error: string | null }>,
  mode: RuntimeMode,
  readyNote: string,
): ProviderHealth {
  const cache = latestByDomain.get(domain);
  const enabled = mode === "live";
  return {
    domain,
    provider: cache?.provider ?? "manual-import",
    enabled,
    source: enabled ? "manual" : "scenario",
    freshness: cacheFreshness(cache, enabled),
    status: enabled && cache ? "ready" : enabled ? "planned" : "disabled",
    lastOkAt: cache?.status === "fresh" || cache?.status === "stale" ? cache.asOf : null,
    lastError: cache?.error ?? null,
    note: cache ? readyNote : "Waiting for first timestamped import before this can be shown as operational data.",
  };
}
