import { z } from "zod";
import { effectiveCongestion } from "@crisisgrid/engine";
import { ClosureState } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { readState, scenarioArgs, type StateReader } from "./common.js";

/**
 * traffic.* — road network tools (plan/05 §2).
 * Route candidates come from the committed network.json (precomputed on real
 * street geometry); congestion and closures come from live scenario state.
 * Hazard exposure (floodplains, closed bridges) is attached to every
 * candidate so agents cannot ignore it — the Route 12 debate depends on this.
 */

function closures(ctx: Parameters<ToolDef["handler"]>[1], s: StateReader): ClosureState[] {
  return ctx.engine
    .entitiesOfType<unknown>(s.scenarioId, s.tick, "closure", s.forkId)
    .map((c) => ClosureState.parse(c));
}

export const trafficTools: ToolDef[] = [
  {
    name: "traffic.get_congestion",
    description:
      "Congestion level (0-1, including dark-signal penalty), trend, and signal status per corridor. Optionally filter by zones.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, zones: z.array(z.string()).optional() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const dataset = ctx.engine.dataset(s.scenarioId);
      const filter = args.zones as string[] | undefined;
      const corridors = dataset.network.corridors
        .filter((c) => !filter || c.zones.some((zn) => filter.includes(zn)))
        .map((c) => {
          const cs = s.corridors.find((x) => x.corridorId === c.id);
          return {
            id: c.id,
            name: c.name,
            zones: c.zones,
            level0to1: cs ? Math.round(effectiveCongestion(cs) * 100) / 100 : 0,
            rawLevel: cs?.level ?? 0,
            trend: cs?.trend ?? "steady",
            signalStatus: cs?.signalStatus ?? "normal",
            baseCapacityVph: c.baseCapacityVph,
          };
        });
      return ctx.wrapAndLog({
        tool: "traffic.get_congestion", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args, data: { corridors }, startedMs: performance.now(),
      });
    },
  },
  {
    name: "traffic.get_road_closures",
    description: "Active road/bridge closures with reason and affected corridor.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      return ctx.wrapAndLog({
        tool: "traffic.get_road_closures", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args, data: { closures: closures(ctx, s) }, startedMs: performance.now(),
      });
    },
  },
  {
    name: "traffic.find_routes",
    description:
      "Candidate routes between zones with live ETA (congestion-adjusted), capacity, hazard exposure (floodplain flood windows, closed bridges), and availability. ALWAYS check hazards[] before recommending a route.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      fromZone: z.string(),
      toZone: z.string(),
      count: z.number().int().min(1).max(5).default(3),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const dataset = ctx.engine.dataset(s.scenarioId);
      const w = s.weather[0];
      const active = closures(ctx, s);
      const floodplains = dataset.city.features.filter((f) => f.properties.kind === "floodplain");

      const routes = dataset.network.routes
        .filter((r) => r.fromZone === args.fromZone && r.toZone === args.toZone)
        .map((r) => {
          // Congestion factor: mean effective level across corridors → 1.0 (free) to 2.5 (jammed).
          const levels = r.corridorIds.map((cid) =>
            effectiveCongestion(s.corridors.find((cs) => cs.corridorId === cid)),
          );
          const meanLevel = levels.reduce((a, b) => a + b, 0) / Math.max(1, levels.length);
          const congestionFactor = 1 + meanLevel * 1.5;

          const hazards: { kind: string; ref: string; detail: string; activeFrom: string | null }[] = [];
          for (const fpId of r.floodplainIds) {
            const fp = floodplains.find(
              (f) => (f.properties as { floodplainId: string }).floodplainId === fpId,
            );
            const threshold = (fp?.properties as { activationThresholdMmHr: number } | undefined)
              ?.activationThresholdMmHr;
            const activating = w && threshold !== undefined && w.peakMmHr * w.intensityFactor >= threshold;
            hazards.push({
              kind: "floodplain",
              ref: fpId,
              detail: activating
                ? `Route crosses ${fpId}; forecast rain (${Math.round((w?.peakMmHr ?? 0) * (w?.intensityFactor ?? 1))} mm/h) exceeds activation threshold ${threshold} mm/h`
                : `Route crosses ${fpId}; below activation threshold at current forecast`,
              activeFrom:
                activating && w ? ctx.engine.simTimeAt(s.scenarioId, w.rainArrivalTick) : null,
            });
          }
          const closedBridges = r.bridgeIds.filter((b) => active.some((c) => c.bridgeId === b));
          for (const b of closedBridges) {
            const c = active.find((cl) => cl.bridgeId === b)!;
            hazards.push({ kind: "closure", ref: b, detail: `${c.name} closed: ${c.reason}`, activeFrom: null });
          }
          const closedCorridors = r.corridorIds.filter((cid) =>
            active.some((c) => c.corridorId === cid && c.bridgeId === null),
          );

          return {
            id: r.id,
            name: r.name,
            etaMin: Math.round(r.baseEtaMin * congestionFactor),
            baseEtaMin: r.baseEtaMin,
            distanceKm: r.distanceKm,
            congestionFactor: Math.round(congestionFactor * 100) / 100,
            available: closedBridges.length === 0 && closedCorridors.length === 0,
            hazards,
            corridorIds: r.corridorIds,
            bridgeIds: r.bridgeIds,
          };
        })
        .sort((a, b) => Number(b.available) - Number(a.available) || a.etaMin - b.etaMin)
        .slice(0, args.count as number);

      return ctx.wrapAndLog({
        tool: "traffic.find_routes", source: "computed", scenarioId: s.scenarioId,
        argsJson: args, data: { routes }, startedMs: performance.now(),
      });
    },
  },
  {
    name: "traffic.estimate_evacuation_time",
    description:
      "Deterministic people-throughput model for moving a population over a route (bottleneck = lowest-capacity corridor adjusted for congestion). Returns total minutes, the bottleneck, and explicit assumptions.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      routeId: z.string(),
      population: z.number().int().positive(),
      transport: z.enum(["mixed", "bus", "car"]).default("mixed"),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const dataset = ctx.engine.dataset(s.scenarioId);
      const route = dataset.network.routes.find((r) => r.id === args.routeId);
      if (!route) throw new Error(`Unknown route ${String(args.routeId)}`);

      // Bottleneck corridor: lowest effective capacity (base * (1 - congestion)).
      let bottleneck = { corridorId: "", effVph: Infinity };
      for (const cid of route.corridorIds) {
        const c = dataset.network.corridors.find((x) => x.id === cid)!;
        const level = effectiveCongestion(s.corridors.find((cs) => cs.corridorId === cid));
        const effVph = c.baseCapacityVph * Math.max(0.1, 1 - level);
        if (effVph < bottleneck.effVph) bottleneck = { corridorId: cid, effVph };
      }
      const personsPerVehicle = args.transport === "bus" ? 30 : args.transport === "car" ? 2.4 : 4;
      const personsPerHour = bottleneck.effVph * personsPerVehicle;
      const flowMin = Math.ceil(((args.population as number) / personsPerHour) * 60);
      const totalMin = flowMin + Math.round(route.baseEtaMin);

      return ctx.wrapAndLog({
        tool: "traffic.estimate_evacuation_time", source: "computed", scenarioId: s.scenarioId,
        argsJson: args,
        data: {
          routeId: route.id,
          totalMin,
          flowMin,
          travelMin: route.baseEtaMin,
          bottleneck: bottleneck.corridorId,
          bottleneckEffectiveVph: Math.round(bottleneck.effVph),
          assumptions: [
            `${personsPerVehicle} persons per vehicle (${String(args.transport)} mode)`,
            "Bottleneck-limited steady flow; no incident on route during evacuation",
            "Congestion held at current levels (re-run after conditions change)",
          ],
        },
        startedMs: performance.now(),
      });
    },
  },
];
