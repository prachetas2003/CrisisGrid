import { z } from "zod";
import { computeRiskOverlay, distanceKm, polygonCentroid } from "@crisisgrid/engine";
import type { ZoneFeature } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { facilitiesOf, readState, scenarioArgs } from "./common.js";

/** geo.* — GIS and risk overlay tools (plan/05 §2, source: scenario + computed). */

/** Colloquial area names → zone sets ("west side" is how operators talk). */
const AREA_ALIASES: Record<string, string[]> = {
  "west side": ["Z-01", "Z-05", "Z-09", "Z-13"],
  westside: ["Z-01", "Z-05", "Z-09", "Z-13"],
  "east side": ["Z-04", "Z-08", "Z-12", "Z-16"],
  downtown: ["Z-06", "Z-10"],
  "river district": ["Z-05", "Z-06", "Z-09", "Z-10"],
};

function zoneFeatures(ctx: Parameters<ToolDef["handler"]>[1], scenarioId: string): ZoneFeature[] {
  return ctx.engine
    .dataset(scenarioId)
    .city.features.filter((f): f is ZoneFeature => f.properties.kind === "zone");
}

export const geoTools: ToolDef[] = [
  {
    name: "geo.geocode",
    description:
      "Resolve a place name, area name (e.g. 'west side'), zone name, or facility name to zones and coordinates. Deterministic lookup over scenario geography.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, query: z.string().min(1) }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const q = (args.query as string).toLowerCase().trim();
      const matches: { zone: string | null; lat: number; lon: number; label: string; confidence: number }[] = [];

      const alias = Object.entries(AREA_ALIASES).find(([k]) => q.includes(k));
      const zones = zoneFeatures(ctx, s.scenarioId);
      if (alias) {
        for (const zid of alias[1]) {
          const zf = zones.find((z) => z.properties.zoneId === zid);
          if (!zf) continue;
          const [lon, lat] = polygonCentroid(zf.geometry.coordinates[0]!);
          matches.push({ zone: zid, lat, lon, label: `${zf.properties.name} (${alias[0]})`, confidence: 0.9 });
        }
      }
      for (const zf of zones) {
        if (zf.properties.name.toLowerCase().includes(q) || zf.properties.zoneId.toLowerCase() === q) {
          const [lon, lat] = polygonCentroid(zf.geometry.coordinates[0]!);
          matches.push({ zone: zf.properties.zoneId, lat, lon, label: zf.properties.name, confidence: 0.95 });
        }
      }
      for (const f of facilitiesOf(ctx, s.scenarioId)) {
        if (f.name.toLowerCase().includes(q)) {
          matches.push({ zone: f.zone, lat: f.lat, lon: f.lon, label: f.name, confidence: 0.85 });
        }
      }
      return ctx.wrapAndLog({
        tool: "geo.geocode",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { matches: matches.slice(0, 10) },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "geo.get_zone_boundaries",
    description:
      "Zone polygons with population, households, density, and vulnerability index. Omit zones for all 16.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, zones: z.array(z.string()).optional() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const filter = args.zones as string[] | undefined;
      const features = zoneFeatures(ctx, s.scenarioId).filter(
        (z) => !filter || filter.includes(z.properties.zoneId),
      );
      return ctx.wrapAndLog({
        tool: "geo.get_zone_boundaries",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { type: "FeatureCollection", features },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "geo.find_nearby_facilities",
    description:
      "Facilities of the given kinds within radiusKm of a zone centroid or explicit point.",
    tier: "safe",
    source: "scenario",
    input: z.object({
      ...scenarioArgs,
      zone: z.string().optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      kinds: z.array(z.enum(["hospital", "shelter", "school", "substation", "signal", "water", "staging"])).min(1),
      radiusKm: z.number().positive().default(6),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      let origin: [number, number];
      if (args.zone) {
        const zf = zoneFeatures(ctx, s.scenarioId).find((z) => z.properties.zoneId === args.zone);
        if (!zf) throw new Error(`Unknown zone ${String(args.zone)}`);
        origin = polygonCentroid(zf.geometry.coordinates[0]!);
      } else if (typeof args.lat === "number" && typeof args.lon === "number") {
        origin = [args.lon, args.lat];
      } else {
        throw new Error("Provide either zone or lat+lon");
      }
      const kinds = args.kinds as string[];
      const radius = args.radiusKm as number;
      const found = facilitiesOf(ctx, s.scenarioId)
        .filter((f) => kinds.includes(f.kind))
        .map((f) => ({ ...f, distanceKm: Math.round(distanceKm(origin, [f.lon, f.lat]) * 100) / 100 }))
        .filter((f) => f.distanceKm <= radius)
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return ctx.wrapAndLog({
        tool: "geo.find_nearby_facilities",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { facilities: found },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "geo.calculate_distance",
    description:
      "Great-circle distance and drive-time estimate between two entities (zone ids or facility ids).",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      fromId: z.string(),
      toId: z.string(),
      mode: z.enum(["drive", "walk"]).default("drive"),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const locate = (id: string): [number, number] => {
        const zf = zoneFeatures(ctx, s.scenarioId).find((z) => z.properties.zoneId === id);
        if (zf) return polygonCentroid(zf.geometry.coordinates[0]!);
        const f = facilitiesOf(ctx, s.scenarioId).find((fa) => fa.id === id);
        if (f) return [f.lon, f.lat];
        throw new Error(`Unknown entity ${id}`);
      };
      const km = distanceKm(locate(args.fromId as string), locate(args.toId as string));
      // Simple urban speed model: drive 30 km/h effective, walk 4.5 km/h.
      const speed = args.mode === "walk" ? 4.5 : 30;
      return ctx.wrapAndLog({
        tool: "geo.calculate_distance",
        source: "computed",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { km: Math.round(km * 100) / 100, etaMin: Math.round((km / speed) * 60) },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "geo.overlay_risk_layers",
    description:
      "THE risk engine: deterministic weighted zone risk from outage (0.25), flood (0.25), congestion (0.15), vulnerability (0.15), critical-facility exposure (0.15), shelter distance (0.05). Returns per-zone scores 0-100 with band and factor contributions, plus city score. This is the single source of the risk score — cite it, never invent one.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, zones: z.array(z.string()).optional() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const overlay = computeRiskOverlay(
        ctx.engine.dataset(s.scenarioId),
        {
          outages: s.outages,
          corridors: s.corridors,
          facilityPower: s.facilityPower,
          weather: s.weather,
        },
        s.tick,
      );
      const filter = args.zones as string[] | undefined;
      return ctx.wrapAndLog({
        tool: "geo.overlay_risk_layers",
        source: "computed",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: {
          perZone: overlay.perZone.filter((z) => !filter || filter.includes(z.zone)),
          cityScore: overlay.cityScore,
        },
        startedMs: performance.now(),
      });
    },
  },
];
