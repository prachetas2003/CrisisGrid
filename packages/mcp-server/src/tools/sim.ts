import { z } from "zod";
import { IncidentActionPlan, type PlannedAction } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { scenarioArgs } from "./common.js";

/**
 * sim.* — scenario engine tools (plan/05 §2).
 * load_scenario / run_what_if are safe (forks never touch live state).
 * advance_time / inject_event mutate shared demo state → approval tier.
 * compare_response_plans is the deterministic diff behind the what-if view.
 */

export const simTools: ToolDef[] = [
  {
    name: "sim.load_scenario",
    description:
      "Load (or reset) a scenario to tick 0. Wipes prior state for that scenario and seeds the deterministic initial state.",
    tier: "safe",
    source: "scenario",
    input: z.object({ scenarioId: z.string().default("westside-cascade") }),
    handler: (args, ctx) => {
      const scenarioId = args.scenarioId as string;
      const result = ctx.engine.load(scenarioId);
      const meta = ctx.engine.dataset(scenarioId).meta;
      return ctx.wrapAndLog({
        tool: "sim.load_scenario",
        source: "scenario",
        scenarioId,
        argsJson: args,
        data: { ...result, name: meta.name, summary: meta.description, dataHonesty: meta.dataHonesty },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "sim.run_what_if",
    description:
      "Fork the current live state, apply hypothetical what-if events (e.g. WHATIF-BRIDGE, WHATIF-RAIN) to the fork only, and return a forkId. Pass that forkId to other tools to analyze the hypothetical world. NEVER mutates the live timeline.",
    tier: "safe",
    source: "scenario",
    input: z.object({ ...scenarioArgs, eventIds: z.array(z.string()).min(1) }),
    handler: (args, ctx) => {
      const scenarioId = ctx.resolveScenario(args.scenarioId as string | undefined);
      const { forkId, changedEntities } = ctx.engine.fork(scenarioId, args.eventIds as string[]);
      const whatifs = ctx.engine
        .listWhatIfs(scenarioId)
        .filter((w) => (args.eventIds as string[]).includes(w.id));
      return ctx.wrapAndLog({
        tool: "sim.run_what_if",
        source: "scenario",
        scenarioId,
        argsJson: args,
        data: {
          forkId,
          changedEntities,
          appliedEvents: whatifs.map((w) => ({ id: w.id, title: w.title, affectedAgents: w.affectedAgents })),
          note: "Hypothetical fork — live state unchanged",
        },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "sim.advance_time",
    description:
      "Advance the LIVE scenario clock by N ticks (5 sim-minutes each), firing scripted timeline events. Mutates shared demo state → approval tier.",
    tier: "approval",
    source: "scenario",
    actionKind: "scenario_mutation",
    input: z.object({
      scenarioId: z.string().optional(),
      ticks: z.number().int().min(1).max(24).default(1),
      approvalToken: z.string().optional(),
    }),
    handler: (args, ctx) => {
      const scenarioId = ctx.resolveScenario(args.scenarioId as string | undefined);
      const results = ctx.engine.tick(scenarioId, args.ticks as number);
      const last = results[results.length - 1]!;
      return ctx.wrapAndLog({
        tool: "sim.advance_time", source: "scenario", scenarioId,
        argsJson: args,
        data: {
          newTick: last.tick,
          simTime: last.simTime,
          firedEvents: results.flatMap((r) => r.firedEvents.map((e) => ({ id: e.id, announcement: e.announcement }))),
        },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "sim.inject_event",
    description:
      "Apply a what-if event to the LIVE timeline (operator 'adopt'). Mutates shared demo state → approval tier. For hypothetical analysis use sim.run_what_if (safe, fork-only) instead.",
    tier: "approval",
    source: "scenario",
    actionKind: "scenario_mutation",
    input: z.object({
      scenarioId: z.string().optional(),
      eventId: z.string().regex(/^WHATIF-[A-Z-]+$/),
      approvalToken: z.string().optional(),
    }),
    handler: (args, ctx) => {
      const scenarioId = ctx.resolveScenario(args.scenarioId as string | undefined);
      const result = ctx.engine.inject(scenarioId, args.eventId as string);
      return ctx.wrapAndLog({
        tool: "sim.inject_event", source: "scenario", scenarioId,
        argsJson: args, data: { applied: true, eventId: args.eventId, ...result },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "sim.compare_response_plans",
    description:
      "Deterministic structured diff of two stored plans: risk delta, added/removed/modified actions (matched by team+timeWindow+title), and route/shelter changes detected from action content. The Commander narrates this diff — it never invents one.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, planIdA: z.string(), planIdB: z.string() }),
    handler: (args, ctx) => {
      const scenarioId = ctx.resolveScenario(args.scenarioId as string | undefined);
      const load = (id: string) => {
        const row = ctx.db.prepare("SELECT plan_json FROM plans WHERE id = ?").get(id) as { plan_json: string } | undefined;
        if (!row) throw new Error(`Unknown plan ${id}`);
        return IncidentActionPlan.parse(JSON.parse(row.plan_json));
      };
      const a = load(args.planIdA as string);
      const b = load(args.planIdB as string);

      const key = (x: PlannedAction) => `${x.targetTeam}|${x.timeWindow}|${x.title.toLowerCase().trim()}`;
      const mapA = new Map(a.actions.map((x) => [key(x), x]));
      const mapB = new Map(b.actions.map((x) => [key(x), x]));
      const addedActions = b.actions.filter((x) => !mapA.has(key(x)));
      const removedActions = a.actions.filter((x) => !mapB.has(key(x))).map((action) => ({ action, reason: "not present in revised plan" }));
      const modifiedActions = b.actions
        .filter((x) => mapA.has(key(x)) && JSON.stringify(mapA.get(key(x))) !== JSON.stringify(x))
        .map((after) => ({ before: mapA.get(key(after))!, after }));

      const routeRefs = (p: typeof a) => new Set((JSON.stringify(p).match(/RT-[A-Z0-9]+/g) ?? []));
      const shelterRefs = (p: typeof a) => new Set((JSON.stringify(p).match(/SHL-[A-Z]+/g) ?? []));
      const routesA = routeRefs(a); const routesB = routeRefs(b);
      const sheltersA = shelterRefs(a); const sheltersB = shelterRefs(b);

      return ctx.wrapAndLog({
        tool: "sim.compare_response_plans", source: "computed", scenarioId,
        argsJson: args,
        data: {
          planA: args.planIdA, planB: args.planIdB,
          riskDelta: { from: a.riskScore, to: b.riskScore },
          confidenceDelta: { from: a.confidence, to: b.confidence },
          addedActions, removedActions, modifiedActions,
          routeChanges: {
            dropped: [...routesA].filter((r) => !routesB.has(r)),
            introduced: [...routesB].filter((r) => !routesA.has(r)),
          },
          shelterChanges: {
            dropped: [...sheltersA].filter((s) => !sheltersB.has(s)),
            introduced: [...sheltersB].filter((s) => !sheltersA.has(s)),
          },
        },
        startedMs: performance.now(),
      });
    },
  },
];
