import { z } from "zod";
import { estimateRestorationPriority } from "@crisisgrid/engine";
import type { ToolDef } from "../registry.js";
import { facilitiesOf, readState, scenarioArgs } from "./common.js";

/** grid.* — power grid and infrastructure tools (plan/05 §2, source: scenario). */

export const gridTools: ToolDef[] = [
  {
    name: "grid.get_outages",
    description:
      "List current power outage entities: substation, affected zones with out/brownout level, customers out, cause, status.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      return ctx.wrapAndLog({
        tool: "grid.get_outages",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { outages: s.outages.filter((o) => o.status !== "restored") },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "grid.get_affected_zones",
    description: "Zones affected by a specific outage, with severity level and customers out.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, outageId: z.string() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const outage = s.outages.find((o) => o.id === args.outageId);
      if (!outage) throw new Error(`Unknown outage ${String(args.outageId)}`);
      return ctx.wrapAndLog({
        tool: "grid.get_affected_zones",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: {
          outageId: outage.id,
          zones: outage.zones,
          customersOut: outage.customersOut,
          cause: outage.cause,
        },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "grid.get_critical_facilities",
    description:
      "Critical facilities (hospitals, shelters, signals, water, schools) in the given zones with power status and backup runtime remaining.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, zones: z.array(z.string()).min(1) }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const zones = args.zones as string[];
      const facilities = facilitiesOf(ctx, s.scenarioId)
        .filter((f) => zones.includes(f.zone) && f.kind !== "staging" && f.kind !== "substation")
        .map((f) => {
          const ps = s.facilityPower.find((p) => p.facilityId === f.id);
          const shelterState = s.shelters.find((sh) => sh.shelterId === f.id);
          return {
            id: f.id,
            kind: f.kind,
            name: f.name,
            zone: f.zone,
            powerStatus: ps?.powerStatus ?? shelterState?.powerStatus ?? "grid",
            backup:
              ps?.powerStatus === "backup"
                ? { type: "generator", remainingH: ps.backupRemainingH }
                : null,
            beds: f.beds ?? null,
            capacity: f.capacity ?? null,
          };
        });
      return ctx.wrapAndLog({
        tool: "grid.get_critical_facilities",
        source: "scenario",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { facilities },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "grid.estimate_restoration_priority",
    description:
      "Deterministic restoration priority ranking for an outage. Policy: life-safety facilities > water > signalized corridors > shelters > customer count. Returns ordered circuits with reasons and crew-hour estimates.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, outageId: z.string() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const outage = s.outages.find((o) => o.id === args.outageId);
      if (!outage) throw new Error(`Unknown outage ${String(args.outageId)}`);
      const ranked = estimateRestorationPriority(
        ctx.engine.dataset(s.scenarioId),
        outage,
        s.facilityPower,
      );
      return ctx.wrapAndLog({
        tool: "grid.estimate_restoration_priority",
        source: "computed",
        scenarioId: s.scenarioId,
        argsJson: args,
        data: { outageId: outage.id, ranked },
        startedMs: performance.now(),
      });
    },
  },
];
