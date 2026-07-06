import { z } from "zod";
import { auditLog } from "@crisisgrid/engine";
import type { ToolDef } from "../registry.js";
import { facilitiesOf, readState, scenarioArgs } from "./common.js";

/** shelters.* — shelter tools (plan/05 §2, source: scenario).
 *  assign_population validates always (overflow rejected with remainder) and
 *  mutates occupancy only when executed with an operator approval token. */

export const shelterTools: ToolDef[] = [
  {
    name: "shelters.list",
    description:
      "All shelters with capacity, current occupancy, power status, accessibility, pet policy, and whether they accept new arrivals.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const shelters = facilitiesOf(ctx, s.scenarioId)
        .filter((f) => f.kind === "shelter")
        .map((f) => {
          const st = s.shelters.find((x) => x.shelterId === f.id);
          return {
            id: f.id,
            name: f.name,
            zone: f.zone,
            lat: f.lat,
            lon: f.lon,
            capacity: f.capacity ?? 0,
            occupied: st?.occupied ?? 0,
            availableBeds: (f.capacity ?? 0) - (st?.occupied ?? 0),
            occupancyPct: f.capacity ? Math.round(((st?.occupied ?? 0) / f.capacity) * 100) : 0,
            powerStatus: st?.powerStatus ?? "grid",
            acceptingNew: st?.acceptingNew ?? true,
            accessible: f.accessible ?? false,
            petFriendly: f.petFriendly ?? false,
          };
        });
      return ctx.wrapAndLog({
        tool: "shelters.list",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { shelters },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "shelters.get_capacity",
    description: "Point-in-time capacity, occupancy, and arrival trend for one shelter.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, shelterId: z.string() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const f = facilitiesOf(ctx, s.scenarioId).find(
        (x) => x.id === args.shelterId && x.kind === "shelter",
      );
      if (!f) throw new Error(`Unknown shelter ${String(args.shelterId)}`);
      const st = s.shelters.find((x) => x.shelterId === f.id);
      return ctx.wrapAndLog({
        tool: "shelters.get_capacity",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: {
          shelterId: f.id,
          name: f.name,
          capacity: f.capacity ?? 0,
          occupied: st?.occupied ?? 0,
          trendPerHour: st?.trendPerHour ?? 0,
          acceptingNew: st?.acceptingNew ?? true,
          powerStatus: st?.powerStatus ?? "grid",
        },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "shelters.assign_population",
    description:
      "Assign population counts from zones to shelters. ALWAYS validates: assignments exceeding capacity (or to shelters not accepting arrivals) are rejected with the unplaced remainder — handle the remainder, never drop it. Approval-tier: occupancy only actually changes when executed with an operator approval token; without one this returns the validation result and enqueues the action.",
    tier: "approval",
    source: "scenario",
    actionKind: "shelter_assignment",
    input: z.object({
      ...scenarioArgs,
      assignments: z
        .array(z.object({ zone: z.string(), shelterId: z.string(), count: z.number().int().positive() }))
        .min(1),
      approvalToken: z.string().optional(),
    }),
    /** Validation used both for the dry-run (enqueue) preview and execution. */
    preview: (args, ctx) => validateAssignments(args, ctx),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const { accepted, rejected } = validateAssignments(args, ctx);
      // Execution path (token verified by middleware): apply accepted assignments.
      const patches = accepted.map((a) => {
        const st = s.shelters.find((x) => x.shelterId === a.shelterId)!;
        return {
          op: "merge" as const,
          entityType: "shelter" as const,
          entityId: a.shelterId,
          data: { occupied: st.occupied + a.count },
        };
      });
      if (patches.length > 0) {
        ctx.engine.mutate(s.scenarioId, patches, `Shelter assignment executed (${accepted.length} assignments)`);
      }
      auditLog(ctx.db, {
        actor: "mcp:shelters.assign_population",
        eventType: "shelter.assignment_executed",
        detail: { accepted, rejected, label: "SIMULATED" },
      });
      return ctx.wrapAndLog({
        tool: "shelters.assign_population", source: "scenario", scenarioId: s.scenarioId,
        argsJson: args, data: { accepted, rejected, applied: patches.length > 0, label: "SIMULATED" },
        startedMs: performance.now(),
      });
    },
  },
];

function validateAssignments(
  args: Record<string, unknown>,
  ctx: Parameters<ToolDef["handler"]>[1],
): {
  accepted: { zone: string; shelterId: string; count: number }[];
  rejected: { zone: string; shelterId: string; count: number; reason: string; remainder: number }[];
} {
  const s = readState(ctx, args);
  const facilities = facilitiesOf(ctx, s.scenarioId);
  const accepted: { zone: string; shelterId: string; count: number }[] = [];
  const rejected: { zone: string; shelterId: string; count: number; reason: string; remainder: number }[] = [];
  // Track cumulative load within this proposal so two assignments can't both fill the same beds.
  const pending = new Map<string, number>();
  for (const a of args.assignments as { zone: string; shelterId: string; count: number }[]) {
    const f = facilities.find((x) => x.id === a.shelterId && x.kind === "shelter");
    const st = s.shelters.find((x) => x.shelterId === a.shelterId);
    if (!f || !st) {
      rejected.push({ ...a, reason: `Unknown shelter ${a.shelterId}`, remainder: a.count });
      continue;
    }
    if (!st.acceptingNew) {
      rejected.push({ ...a, reason: `${f.name} is not accepting new arrivals`, remainder: a.count });
      continue;
    }
    const already = pending.get(a.shelterId) ?? 0;
    const available = (f.capacity ?? 0) - st.occupied - already;
    if (a.count <= available) {
      accepted.push(a);
      pending.set(a.shelterId, already + a.count);
    } else if (available > 0) {
      accepted.push({ ...a, count: available });
      pending.set(a.shelterId, already + available);
      rejected.push({
        ...a,
        reason: `${f.name} can take only ${available} of ${a.count} (capacity ${f.capacity}, occupied ${st.occupied + already})`,
        remainder: a.count - available,
      });
    } else {
      rejected.push({
        ...a,
        reason: `${f.name} is full (capacity ${f.capacity}, occupied ${st.occupied + already})`,
        remainder: a.count,
      });
    }
  }
  return { accepted, rejected };
}
