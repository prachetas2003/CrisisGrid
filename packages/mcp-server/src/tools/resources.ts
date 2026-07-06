import { z } from "zod";
import { auditLog, distanceKm, polygonCentroid } from "@crisisgrid/engine";
import { ResourceUnitState, type ZoneFeature } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { readState, scenarioArgs } from "./common.js";

/** resources.* — emergency resource tools (plan/05 §2, source: scenario). */

function zoneCentroid(
  ctx: Parameters<ToolDef["handler"]>[1],
  scenarioId: string,
  zone: string,
): [number, number] {
  const zf = ctx.engine
    .dataset(scenarioId)
    .city.features.find(
      (f): f is ZoneFeature => f.properties.kind === "zone" && (f.properties as { zoneId?: string }).zoneId === zone,
    );
  if (!zf) throw new Error(`Unknown zone ${zone}`);
  return polygonCentroid(zf.geometry.coordinates[0]!);
}

export const resourceTools: ToolDef[] = [
  {
    name: "resources.get_available_units",
    description:
      "Emergency resource units (utility crews, bus groups, generators, pump crews, mobile command) with location zone, status, and passenger capacity where applicable.",
    tier: "safe",
    source: "scenario",
    input: z.object({
      ...scenarioArgs,
      kinds: z
        .array(z.enum(["utility_crew", "bus_group", "generator", "pump_crew", "mobile_command"]))
        .optional(),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const kinds = args.kinds as string[] | undefined;
      const units = ctx.engine
        .entitiesOfType<unknown>(s.scenarioId, s.tick, "resourceUnit", s.forkId)
        .map((u) => ResourceUnitState.parse(u))
        .filter((u) => !kinds || kinds.includes(u.kind));
      return ctx.wrapAndLog({
        tool: "resources.get_available_units",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { units },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "resources.recommend_staging",
    description:
      "Deterministic staging optimizer: for each requested unit kind, picks the nearest AVAILABLE units to the target zone (greedy by drive time) and returns staging recommendations with arrive-by times and rationale. Recommendation only — committing a unit requires resources.assign_unit with operator approval.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      targetZone: z.string(),
      needs: z.array(z.object({
        kind: z.enum(["utility_crew", "bus_group", "generator", "pump_crew", "mobile_command"]),
        count: z.number().int().min(1).max(5),
      })).min(1),
      arriveWithinMin: z.number().int().min(5).max(240).default(45),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const target = zoneCentroid(ctx, s.scenarioId, args.targetZone as string);
      const units = ctx.engine
        .entitiesOfType<unknown>(s.scenarioId, s.tick, "resourceUnit", s.forkId)
        .map((u) => ResourceUnitState.parse(u))
        .filter((u) => u.status === "available");

      const staging: { unitId: string; kind: string; fromZone: string; etaMin: number; arriveBy: string; rationale: string; feasible: boolean }[] = [];
      const shortfalls: { kind: string; requested: number; available: number }[] = [];
      for (const need of args.needs as { kind: string; count: number }[]) {
        const candidates = units
          .filter((u) => u.kind === need.kind)
          .map((u) => {
            const from = zoneCentroid(ctx, s.scenarioId, u.zone);
            const etaMin = Math.round((distanceKm(from, target) / 30) * 60) + 5; // 30 km/h urban + 5 min mobilization
            return { unit: u, etaMin };
          })
          .sort((a, b) => a.etaMin - b.etaMin || a.unit.unitId.localeCompare(b.unit.unitId));
        const picked = candidates.slice(0, need.count);
        if (picked.length < need.count)
          shortfalls.push({ kind: need.kind, requested: need.count, available: picked.length });
        for (const p of picked) {
          const arriveTick = s.tick + Math.ceil(p.etaMin / 5);
          staging.push({
            unitId: p.unit.unitId,
            kind: p.unit.kind,
            fromZone: p.unit.zone,
            etaMin: p.etaMin,
            arriveBy: ctx.engine.simTimeAt(s.scenarioId, arriveTick),
            rationale: `Nearest available ${p.unit.kind} to ${String(args.targetZone)} (${p.etaMin} min from ${p.unit.zone})`,
            feasible: p.etaMin <= (args.arriveWithinMin as number),
          });
        }
      }
      return ctx.wrapAndLog({
        tool: "resources.recommend_staging", source: "computed", scenarioId: s.scenarioId,
        argsJson: args, data: { staging, shortfalls }, startedMs: performance.now(),
      });
    },
  },
  {
    name: "resources.assign_unit",
    description:
      "Commit a resource unit to a task at a zone (SIMULATED dispatch — clearly labeled, no real system is contacted). Approval-tier: without an operator token this enqueues the assignment and returns PENDING_APPROVAL.",
    tier: "approval",
    source: "scenario",
    actionKind: "resource_assignment",
    input: z.object({
      ...scenarioArgs,
      unitId: z.string(),
      task: z.string(),
      zone: z.string(),
      approvalToken: z.string().optional(),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const unit = ctx.engine
        .entitiesOfType<unknown>(s.scenarioId, s.tick, "resourceUnit", s.forkId)
        .map((u) => ResourceUnitState.parse(u))
        .find((u) => u.unitId === args.unitId);
      if (!unit) throw new Error(`Unknown unit ${String(args.unitId)}`);
      if (unit.status !== "available" && unit.status !== "staged")
        throw new Error(`Unit ${unit.unitId} is ${unit.status}, not assignable`);
      ctx.engine.mutate(
        s.scenarioId,
        [{ op: "merge", entityType: "resourceUnit", entityId: unit.unitId, data: { status: "assigned", zone: args.zone as string } }],
        `SIMULATED dispatch: ${unit.unitId} → ${String(args.zone)} (${String(args.task)})`,
      );
      auditLog(ctx.db, {
        actor: "mcp:resources.assign_unit",
        eventType: "resource.assigned",
        detail: { unitId: unit.unitId, task: args.task, zone: args.zone, label: "SIMULATED" },
      });
      return ctx.wrapAndLog({
        tool: "resources.assign_unit", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args,
        data: { assignmentId: `asg-${unit.unitId}-${s.tick}`, unitId: unit.unitId, zone: args.zone, task: args.task, label: "SIMULATED" },
        startedMs: performance.now(),
      });
    },
  },
];
