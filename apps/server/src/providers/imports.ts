import { z } from "zod";
import { auditLog, type Db, type ScenarioEngine } from "@crisisgrid/engine";
import type { StatePatch } from "@crisisgrid/shared";
import { writeProviderCache } from "./live.js";
import { broadcast } from "../sse/bus.js";

const ZoneLevel = z.enum(["out", "brownout"]);
const PowerStatus = z.enum(["grid", "backup", "out"]);
const Trend = z.enum(["falling", "steady", "rising"]);
const SignalStatus = z.enum(["normal", "dark", "flash"]);

const GridOutageImport = z.object({
  outageId: z.string().default("LIVE-OUTAGE"),
  substation: z.string(),
  zones: z.array(z.object({ zone: z.string(), level: ZoneLevel })).min(1),
  customersOut: z.number().int().min(0),
  cause: z.string().default("Imported outage feed"),
  status: z.enum(["active", "partial_restore", "restored"]).default("active"),
});

const TrafficImport = z.object({
  corridorId: z.string(),
  level: z.number().min(0).max(1),
  trend: Trend.default("steady"),
  signalStatus: SignalStatus.default("normal"),
});

const ClosureImport = z.object({
  closureId: z.string(),
  name: z.string(),
  kind: z.enum(["bridge", "road", "lane"]),
  reason: z.string(),
  bridgeId: z.string().nullable().default(null),
  corridorId: z.string().nullable().default(null),
});

const ShelterImport = z.object({
  shelterId: z.string(),
  occupied: z.number().int().min(0),
  trendPerHour: z.number().default(0),
  powerStatus: PowerStatus.default("grid"),
  acceptingNew: z.boolean().default(true),
});

const FacilityPowerImport = z.object({
  facilityId: z.string(),
  powerStatus: PowerStatus,
  backupRemainingH: z.number().min(0).nullable().default(null),
});

export const LiveImportRequest = z.object({
  scenarioId: z.string().default("westside-cascade"),
  provider: z.string().default("manual-import"),
  asOf: z.string().datetime().optional(),
  ttlMinutes: z.number().int().min(1).max(24 * 60).default(60),
  gridOutages: z.array(GridOutageImport).default([]),
  traffic: z.array(TrafficImport).default([]),
  closures: z.array(ClosureImport).default([]),
  shelters: z.array(ShelterImport).default([]),
  facilityPower: z.array(FacilityPowerImport).default([]),
});

export type LiveImportRequest = z.infer<typeof LiveImportRequest>;

export function applyLiveImport(db: Db, engine: ScenarioEngine, input: LiveImportRequest) {
  ensureScenarioLoaded(engine, input.scenarioId);
  const tick = engine.currentTick(input.scenarioId);
  const simTime = engine.simTimeAt(input.scenarioId, tick);
  const asOf = input.asOf ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(asOf) + input.ttlMinutes * 60_000).toISOString();
  const patches = patchesFromImport(input, tick);

  if (patches.length > 0) {
    engine.ingest(input.scenarioId, patches, `Live data import from ${input.provider}`);
  }

  const cached = [
    input.gridOutages.length
      ? cacheDomain(db, "grid.outages", input.provider, asOf, expiresAt, {
          scenarioId: input.scenarioId,
          simTime,
          gridOutages: input.gridOutages,
        })
      : null,
    input.traffic.length || input.closures.length
      ? cacheDomain(db, "traffic.closures", input.provider, asOf, expiresAt, {
          scenarioId: input.scenarioId,
          simTime,
          traffic: input.traffic,
          closures: input.closures,
        })
      : null,
    input.shelters.length
      ? cacheDomain(db, "shelters.status", input.provider, asOf, expiresAt, {
          scenarioId: input.scenarioId,
          simTime,
          shelters: input.shelters,
        })
      : null,
    input.facilityPower.length
      ? cacheDomain(db, "facilities.power", input.provider, asOf, expiresAt, {
          scenarioId: input.scenarioId,
          simTime,
          facilityPower: input.facilityPower,
        })
      : null,
  ].filter(Boolean);

  const audit = auditLog(db, {
    actor: `provider:${input.provider}`,
    eventType: "provider.import.applied",
    detail: {
      scenarioId: input.scenarioId,
      domains: cached.map((row) => row!.domain),
      patches: patches.length,
      asOf,
      expiresAt,
    },
  });

  const result = {
    scenarioId: input.scenarioId,
    tick,
    simTime,
    provider: input.provider,
    asOf,
    expiresAt,
    patchesApplied: patches.length,
    domains: cached,
    auditId: audit.auditId,
  };
  broadcast({ type: "providers.imported", payload: result });
  broadcast({ type: "scenario.tick", payload: { scenarioId: input.scenarioId, tick, simTime } });
  return result;
}

function patchesFromImport(input: LiveImportRequest, tick: number): StatePatch[] {
  return [
    ...input.gridOutages.map((outage) => ({
      op: "set" as const,
      entityType: "outage" as const,
      entityId: outage.outageId,
      data: {
        id: outage.outageId,
        substation: outage.substation,
        zones: outage.zones,
        customersOut: outage.customersOut,
        cause: outage.cause,
        startedAtTick: tick,
        status: outage.status,
      },
    })),
    ...input.traffic.map((corridor) => ({
      op: "merge" as const,
      entityType: "corridor" as const,
      entityId: corridor.corridorId,
      data: corridor,
    })),
    ...input.closures.map((closure) => ({
      op: "set" as const,
      entityType: "closure" as const,
      entityId: closure.closureId,
      data: {
        ...closure,
        sinceTick: tick,
      },
    })),
    ...input.shelters.map((shelter) => ({
      op: "merge" as const,
      entityType: "shelter" as const,
      entityId: shelter.shelterId,
      data: shelter,
    })),
    ...input.facilityPower.map((facility) => ({
      op: "merge" as const,
      entityType: "facilityPower" as const,
      entityId: facility.facilityId,
      data: facility,
    })),
  ];
}

function cacheDomain(db: Db, domain: string, provider: string, asOf: string, expiresAt: string, payload: unknown) {
  return writeProviderCache(db, {
    id: `${domain}:${provider}`,
    domain,
    provider,
    source: "manual",
    status: "fresh",
    asOf,
    expiresAt,
    payload,
  });
}

function ensureScenarioLoaded(engine: ScenarioEngine, scenarioId: string): void {
  try {
    engine.currentTick(scenarioId);
  } catch {
    engine.load(scenarioId);
  }
}
