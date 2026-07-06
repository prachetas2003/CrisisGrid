import { z } from "zod";
import { ZoneId } from "./core.js";

/**
 * Scenario dataset schemas (plan/06-data-strategy.md §3).
 * Files in scenarios/<id>/ must validate against these at load time.
 */

// ---------- GeoJSON (narrowed to what we use) ----------

export const LngLat = z.tuple([z.number(), z.number()]);
export type LngLat = z.infer<typeof LngLat>;

export const PolygonGeometry = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(LngLat).min(4)),
});
export const LineStringGeometry = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(LngLat).min(2),
});
export const PointGeometry = z.object({
  type: z.literal("Point"),
  coordinates: LngLat,
});

export const VulnerabilityIndex = z.object({
  elderlyPct: z.number().min(0).max(100),
  medDevicePct: z.number().min(0).max(100),
  nonEnglishPct: z.number().min(0).max(100),
  mobilityPct: z.number().min(0).max(100),
});
export type VulnerabilityIndex = z.infer<typeof VulnerabilityIndex>;

export const ZoneFeature = z.object({
  type: z.literal("Feature"),
  geometry: PolygonGeometry,
  properties: z.object({
    kind: z.literal("zone"),
    zoneId: ZoneId,
    name: z.string(),
    population: z.number().int().positive(),
    households: z.number().int().positive(),
    density: z.enum(["low", "medium", "high"]),
    vulnerabilityIndex: VulnerabilityIndex,
  }),
});
export type ZoneFeature = z.infer<typeof ZoneFeature>;

export const RiverFeature = z.object({
  type: z.literal("Feature"),
  geometry: LineStringGeometry,
  properties: z.object({ kind: z.literal("river"), name: z.string() }),
});

export const FloodplainFeature = z.object({
  type: z.literal("Feature"),
  geometry: PolygonGeometry,
  properties: z.object({
    kind: z.literal("floodplain"),
    floodplainId: z.string(),
    returnPeriod: z.string(),
    /** Rain intensity (mm/h sustained) at which this floodplain is considered activating. */
    activationThresholdMmHr: z.number().positive(),
    zones: z.array(ZoneId),
  }),
});
export type FloodplainFeature = z.infer<typeof FloodplainFeature>;

export const BridgeFeature = z.object({
  type: z.literal("Feature"),
  geometry: PointGeometry,
  properties: z.object({
    kind: z.literal("bridge"),
    bridgeId: z.string(),
    name: z.string(),
    corridorId: z.string(),
  }),
});
export type BridgeFeature = z.infer<typeof BridgeFeature>;

export const CityGeoJson = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.union([ZoneFeature, RiverFeature, FloodplainFeature, BridgeFeature])),
});
export type CityGeoJson = z.infer<typeof CityGeoJson>;

// ---------- Facilities ----------

export const FacilityKind = z.enum([
  "hospital",
  "shelter",
  "school",
  "substation",
  "signal",
  "water",
  "staging",
]);
export type FacilityKind = z.infer<typeof FacilityKind>;

export const Facility = z.object({
  id: z.string(),
  kind: FacilityKind,
  name: z.string(),
  zone: ZoneId,
  lat: z.number(),
  lon: z.number(),
  // kind-specific optional attributes
  beds: z.number().int().positive().optional(),
  backupGen: z.object({ fuelHours: z.number().positive() }).optional(),
  capacity: z.number().int().positive().optional(),
  accessible: z.boolean().optional(),
  petFriendly: z.boolean().optional(),
  /** substation → zones it feeds */
  feeds: z.array(ZoneId).optional(),
  /** signal → corridor it controls */
  corridorId: z.string().optional(),
});
export type Facility = z.infer<typeof Facility>;

export const FacilitiesFile = z.object({ facilities: z.array(Facility) });
export type FacilitiesFile = z.infer<typeof FacilitiesFile>;

// ---------- Road network ----------

export const Corridor = z.object({
  id: z.string(),
  name: z.string(),
  zones: z.array(ZoneId),
  geo: LineStringGeometry,
  baseCapacityVph: z.number().int().positive(),
});
export type Corridor = z.infer<typeof Corridor>;

export const RouteDef = z.object({
  id: z.string(),
  name: z.string(),
  fromZone: ZoneId,
  toZone: ZoneId,
  corridorIds: z.array(z.string()).min(1),
  bridgeIds: z.array(z.string()),
  floodplainIds: z.array(z.string()),
  baseEtaMin: z.number().positive(),
  distanceKm: z.number().positive(),
});
export type RouteDef = z.infer<typeof RouteDef>;

export const NetworkFile = z.object({
  corridors: z.array(Corridor),
  routes: z.array(RouteDef),
});
export type NetworkFile = z.infer<typeof NetworkFile>;

// ---------- Mutable entity states (live in scenario_state) ----------

export const OutageState = z.object({
  id: z.string(),
  substation: z.string(),
  zones: z.array(z.object({ zone: ZoneId, level: z.enum(["out", "brownout"]) })),
  customersOut: z.number().int().min(0),
  cause: z.string(),
  startedAtTick: z.number().int().min(0),
  status: z.enum(["active", "partial_restore", "restored"]),
});
export type OutageState = z.infer<typeof OutageState>;

export const CorridorState = z.object({
  corridorId: z.string(),
  /** 0..1 congestion level before signal penalty. */
  level: z.number().min(0).max(1),
  trend: z.enum(["falling", "steady", "rising"]),
  signalStatus: z.enum(["normal", "dark", "flash"]),
});
export type CorridorState = z.infer<typeof CorridorState>;

export const ShelterState = z.object({
  shelterId: z.string(),
  occupied: z.number().int().min(0),
  trendPerHour: z.number(),
  powerStatus: z.enum(["grid", "backup", "out"]),
  acceptingNew: z.boolean(),
});
export type ShelterState = z.infer<typeof ShelterState>;

export const FacilityPowerState = z.object({
  facilityId: z.string(),
  powerStatus: z.enum(["grid", "backup", "out"]),
  backupRemainingH: z.number().nullable(),
});
export type FacilityPowerState = z.infer<typeof FacilityPowerState>;

export const ResourceUnitState = z.object({
  unitId: z.string(),
  kind: z.enum(["utility_crew", "bus_group", "generator", "pump_crew", "mobile_command"]),
  zone: ZoneId,
  status: z.enum(["available", "staged", "assigned", "out_of_service"]),
  capacity: z.number().int().positive().nullable(),
});
export type ResourceUnitState = z.infer<typeof ResourceUnitState>;

export const ClosureState = z.object({
  closureId: z.string(),
  name: z.string(),
  kind: z.enum(["bridge", "road", "lane"]),
  reason: z.string(),
  sinceTick: z.number().int().min(0),
  bridgeId: z.string().nullable(),
  corridorId: z.string().nullable(),
});
export type ClosureState = z.infer<typeof ClosureState>;

/** One weather state per region group (M1: single "west-metro" cell). */
export const WeatherState = z.object({
  cellId: z.string(),
  summary: z.string(),
  precipNowMmHr: z.number().min(0),
  windGustKmh: z.number().min(0),
  /** Tick at which heavy rain reaches the west zones. */
  rainArrivalTick: z.number().int(),
  /** Peak sustained intensity expected on arrival. */
  peakMmHr: z.number().min(0),
  /** Multiplier applied by what-ifs (WHATIF-RAIN sets 1.5). */
  intensityFactor: z.number().positive(),
  perZoneRisk: z.array(
    z.object({ zone: ZoneId, floodRelevance: z.enum(["low", "medium", "high"]) }),
  ),
});
export type WeatherState = z.infer<typeof WeatherState>;

export const Report311State = z.object({
  reportId: z.string(),
  atTick: z.number().int().min(0),
  location: z.string(),
  zone: ZoneId,
  count: z.number().int().positive(),
  text: z.string(),
  verified: z.boolean(),
});
export type Report311State = z.infer<typeof Report311State>;

export const EntityType = z.enum([
  "outage",
  "corridor",
  "shelter",
  "facilityPower",
  "resourceUnit",
  "closure",
  "weather",
  "report311",
  "riskOverlay",
]);
export type EntityType = z.infer<typeof EntityType>;

// ---------- Initial state / timeline / what-ifs ----------

/**
 * Timeline events mutate entity state via shallow merge patches
 * (deliberate simplification of JSON Patch — deterministic and auditable).
 * op "set" creates/replaces the entity; op "merge" shallow-merges fields.
 */
export const StatePatch = z.object({
  op: z.enum(["set", "merge", "delete"]),
  entityType: EntityType,
  entityId: z.string(),
  data: z.record(z.unknown()).optional(),
});
export type StatePatch = z.infer<typeof StatePatch>;

export const TimelineEvent = z.object({
  tick: z.number().int().min(0),
  id: z.string(),
  type: z.string(),
  /** Operational text surfaced verbatim in UI and reports. */
  announcement: z.string(),
  patches: z.array(StatePatch),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const TimelineFile = z.object({ events: z.array(TimelineEvent) });
export type TimelineFile = z.infer<typeof TimelineFile>;

export const WhatIfEvent = z.object({
  id: z.string().regex(/^WHATIF-[A-Z-]+$/),
  title: z.string(),
  description: z.string(),
  patches: z.array(StatePatch),
  /** Which domain agents must re-run when this fires (plan/07 §5). */
  affectedAgents: z.array(z.enum(["weather", "power", "traffic", "shelter"])),
});
export type WhatIfEvent = z.infer<typeof WhatIfEvent>;

export const WhatIfsFile = z.object({ whatifs: z.array(WhatIfEvent) });
export type WhatIfsFile = z.infer<typeof WhatIfsFile>;

export const InitialStateFile = z.object({
  scenarioId: z.string(),
  /** Simulated wall clock at tick 0, ISO local (e.g. "2026-07-02T17:20:00"). */
  startSimTime: z.string(),
  minutesPerTick: z.number().int().positive(),
  entities: z.array(
    z.object({
      entityType: EntityType,
      entityId: z.string(),
      state: z.record(z.unknown()),
    }),
  ),
});
export type InitialStateFile = z.infer<typeof InitialStateFile>;

export const ScenarioMeta = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  city: z.string(),
  dataHonesty: z.string(),
});
export type ScenarioMeta = z.infer<typeof ScenarioMeta>;
