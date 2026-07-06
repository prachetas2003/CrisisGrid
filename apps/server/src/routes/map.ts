import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db, ScenarioEngine } from "@crisisgrid/engine";
import type { SourceMetadata } from "@crisisgrid/shared";
import { runtimeSnapshot } from "./runtime.js";
import {
  latestProviderCacheByDomain,
  latestProviderPayload,
  providerSource,
  providerSourceByDomain,
  refreshLiveProviders,
  type WeatherForecastPayload,
} from "../providers/live.js";
import { applyLiveImport, LiveImportRequest } from "../providers/imports.js";
import { broadcast } from "../sse/bus.js";
import { requireRole } from "../security/auth.js";

const DEFAULT_SCENARIO_ID = "westside-cascade";

export function mapRoutes(app: FastifyInstance, db: Db, engine: ScenarioEngine): void {
  app.get("/api/map/snapshot", async (req) => {
    const query = z
      .object({
        scenarioId: z.string().default(DEFAULT_SCENARIO_ID),
        tick: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    await refreshLiveProviders(db, engine, query.scenarioId);
    return buildMapSnapshot(db, engine, query.scenarioId, query.tick);
  });

  app.get("/api/map/layers", async (req) => {
    const query = z.object({ scenarioId: z.string().default(DEFAULT_SCENARIO_ID) }).parse(req.query);
    await refreshLiveProviders(db, engine, query.scenarioId);
    const snapshot = buildMapSnapshot(db, engine, query.scenarioId);
    return {
      scenarioId: snapshot.scenario.id,
      tick: snapshot.tick,
      simTime: snapshot.simTime,
      layers: snapshot.layers,
    };
  });

  app.get("/api/sources", async (req) => {
    const query = z.object({ scenarioId: z.string().default(DEFAULT_SCENARIO_ID) }).parse(req.query);
    await refreshLiveProviders(db, engine, query.scenarioId);
    const snapshot = buildMapSnapshot(db, engine, query.scenarioId);
    return {
      runtime: snapshot.runtime,
      scenario: snapshot.scenario,
      sources: snapshot.sources,
      providers: snapshot.runtime.providers,
    };
  });

  app.post("/api/providers/refresh", { preHandler: requireRole("operator") }, async (req) => {
    const body = z
      .object({
        scenarioId: z.string().default(DEFAULT_SCENARIO_ID),
        force: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    const result = await refreshLiveProviders(db, engine, body.scenarioId, { force: body.force });
    broadcast({ type: "providers.refreshed", payload: result });
    return result;
  });

  app.post("/api/providers/import", { preHandler: requireRole("operator") }, async (req) => {
    const body = LiveImportRequest.parse(req.body ?? {});
    return applyLiveImport(db, engine, body);
  });
}

function buildMapSnapshot(db: Db, engine: ScenarioEngine, scenarioId: string, requestedTick?: number) {
  const loaded = ensureScenarioLoaded(engine, scenarioId);
  if (loaded) broadcast({ type: "scenario.loaded", payload: { scenarioId, ...loaded } });

  const currentTick = engine.currentTick(scenarioId);
  const tick = requestedTick === undefined ? currentTick : Math.min(requestedTick, currentTick);
  const simTime = engine.simTimeAt(scenarioId, tick);
  const dataset = engine.dataset(scenarioId);
  const scenarioSource = source("scenario", scenarioId, simTime, "fresh", dataset.meta.dataHonesty);
  const weatherForecastSource = providerSource(
    db,
    "weather.forecast",
    "Open-Meteo",
    scenarioSource,
  );
  const gridSource = providerSourceByDomain(db, "grid.outages", scenarioSource);
  const trafficSource = providerSourceByDomain(db, "traffic.closures", scenarioSource);
  const shelterSource = providerSourceByDomain(db, "shelters.status", scenarioSource);
  const facilityPowerSource = providerSourceByDomain(db, "facilities.power", gridSource);
  const computedSource = source(
    "computed",
    "ScenarioEngine",
    simTime,
    "fresh",
    `Computed from current scenario state and static geometry. Weather forecast freshness: ${weatherForecastSource.freshness}.`,
  );
  const providerData = {
    weatherForecast: latestProviderPayload<WeatherForecastPayload>(
      db,
      "weather.forecast",
      "Open-Meteo",
    ),
    gridOutages: latestPayloadByDomain(db, "grid.outages"),
    traffic: latestPayloadByDomain(db, "traffic.closures"),
    shelters: latestPayloadByDomain(db, "shelters.status"),
    facilityPower: latestPayloadByDomain(db, "facilities.power"),
  };
  const importedIds = importedEntityIds(providerData);

  const entities = engine.stateAt(scenarioId, tick).map((row) => ({
    ...row,
    source: entitySource(row.entityType, row.entityId, importedIds, {
      scenarioSource,
      computedSource,
      gridSource,
      trafficSource,
      shelterSource,
      facilityPowerSource,
    }),
  }));

  const byType: Record<string, unknown[]> = {};
  for (const row of entities) {
    byType[row.entityType] ??= [];
    byType[row.entityType]!.push({
      entityId: row.entityId,
      ...row.state,
      source: row.source,
    });
  }

  const runtime = runtimeSnapshot(db);
  const layers = [
    layer("zones", "Scenario zone polygons", scenarioSource, true),
    layer("facilities", "Scenario facilities and static real-coordinate locations", scenarioSource, true),
    layer("network", "Scenario road corridors on real-coordinate geometry", scenarioSource, true),
    layer("riskOverlay", "Computed city and zone risk overlay", computedSource, true),
    layer("weather", "Scenario weather frame used by risk and agent tools", scenarioSource, true),
    layer("weatherForecast", "Provider forecast for live operations", weatherForecastSource, runtime.mode === "live"),
    layer("outages", "Outage state", gridSource, true),
    layer("traffic", "Corridor congestion and signal state", trafficSource, true),
    layer("shelters", "Shelter occupancy and power state", shelterSource, true),
    layer("facilityPower", "Facility and signal power state", facilityPowerSource, true),
    layer("closures", "Road and bridge closures", trafficSource, true),
  ];

  return {
    runtime,
    scenario: {
      id: dataset.meta.id,
      name: dataset.meta.name,
      city: dataset.meta.city,
      description: dataset.meta.description,
      dataHonesty: dataset.meta.dataHonesty,
    },
    tick,
    currentTick,
    simTime,
    generatedAt: new Date().toISOString(),
    sources: {
      scenario: scenarioSource,
      computed: computedSource,
      runtime: source(runtime.mode === "live" ? "live" : "scenario", "CrisisGrid runtime", runtime.generatedAt, "fresh"),
      weatherForecast: weatherForecastSource,
      gridOutages: gridSource,
      traffic: trafficSource,
      shelters: shelterSource,
      facilityPower: facilityPowerSource,
    },
    layers,
    geometry: {
      city: dataset.city,
      facilities: dataset.facilities,
      network: dataset.network,
    },
    state: {
      entities,
      byType,
    },
    providerData,
    events: engine.firedEvents(scenarioId),
    whatifs: dataset.whatifs,
  };
}

function ensureScenarioLoaded(engine: ScenarioEngine, scenarioId: string): { tick: number; simTime: string } | null {
  try {
    engine.currentTick(scenarioId);
    return null;
  } catch {
    return engine.load(scenarioId);
  }
}

function source(
  sourceKind: SourceMetadata["source"],
  provider: string,
  asOf: string,
  freshness: SourceMetadata["freshness"],
  note?: string,
): SourceMetadata {
  return {
    source: sourceKind,
    provider,
    asOf,
    freshness,
    ...(note ? { note } : {}),
  };
}

function entitySource(
  entityType: string,
  entityId: string,
  importedIds: Record<string, Set<string>>,
  sources: {
    scenarioSource: SourceMetadata;
    computedSource: SourceMetadata;
    gridSource: SourceMetadata;
    trafficSource: SourceMetadata;
    shelterSource: SourceMetadata;
    facilityPowerSource: SourceMetadata;
  },
): SourceMetadata {
  if (entityType === "riskOverlay") return sources.computedSource;
  if (entityType === "outage") return importedIds.outage?.has(entityId) ? sources.gridSource : sources.scenarioSource;
  if (entityType === "corridor") return importedIds.corridor?.has(entityId) ? sources.trafficSource : sources.scenarioSource;
  if (entityType === "closure") return importedIds.closure?.has(entityId) ? sources.trafficSource : sources.scenarioSource;
  if (entityType === "shelter") return importedIds.shelter?.has(entityId) ? sources.shelterSource : sources.scenarioSource;
  if (entityType === "facilityPower") {
    return importedIds.facilityPower?.has(entityId) ? sources.facilityPowerSource : sources.scenarioSource;
  }
  return sources.scenarioSource;
}

function importedEntityIds(providerData: Record<string, unknown>): Record<string, Set<string>> {
  return {
    outage: idsFrom(providerData.gridOutages, "gridOutages", ["outageId", "id"]),
    corridor: idsFrom(providerData.traffic, "traffic", ["corridorId", "id"]),
    closure: idsFrom(providerData.traffic, "closures", ["closureId", "id"]),
    shelter: idsFrom(providerData.shelters, "shelters", ["shelterId", "id"]),
    facilityPower: idsFrom(providerData.facilityPower, "facilityPower", ["facilityId", "id"]),
  };
}

function idsFrom(payload: unknown, collectionKey: string, idKeys: string[]): Set<string> {
  const ids = new Set<string>();
  if (!payload || typeof payload !== "object") return ids;
  const collection = (payload as Record<string, unknown>)[collectionKey];
  if (!Array.isArray(collection)) return ids;
  for (const item of collection) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = idKeys.map((key) => record[key]).find((value) => typeof value === "string");
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function latestPayloadByDomain<T = unknown>(db: Db, domain: string): T | null {
  const row = latestProviderCacheByDomain(db, domain);
  return row ? JSON.parse(row.payload_json) as T : null;
}

function layer(
  id: string,
  label: string,
  sourceMetadata: SourceMetadata,
  visible: boolean,
): { id: string; label: string; visible: boolean; source: SourceMetadata } {
  return { id, label, visible, source: sourceMetadata };
}
