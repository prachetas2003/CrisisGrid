import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditLog } from "@crisisgrid/engine";
import type { ToolDef } from "../registry.js";
import { readState, scenarioArgs } from "./common.js";
import { buildBundle, renderIncidentBrief, type ReportBundle } from "./reportRender.js";

/**
 * report.* — incident brief tools (plan/05 §2).
 * All numbers/timestamps come from the DB bundle (deterministic); the agent
 * only contributes narrative sections. This is how eval 12 (report
 * integrity) stays checkable.
 */

export const reportTools: ToolDef[] = [
  {
    name: "report.generate_incident_brief",
    description:
      "Assemble the full data bundle for an incident from the database: parsed incident, findings, latest plan, actions with approvals/blocks, comms drafts, sandbox publishes, timeline events, tool-call stats, audit tail. Feed this to report.export_markdown.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, incidentId: z.string() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const bundle = buildBundle(ctx, s.scenarioId, args.incidentId as string);
      return ctx.wrapAndLog({
        tool: "report.generate_incident_brief", source: "computed", scenarioId: s.scenarioId,
        argsJson: args, data: bundle, startedMs: performance.now(),
      });
    },
  },
  {
    name: "report.generate_action_plan",
    description: "ICS-style incident action plan bundle: objectives, assignments by team, time phases, comms plan, safety notes for the latest plan revision.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, incidentId: z.string() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const bundle = buildBundle(ctx, s.scenarioId, args.incidentId as string);
      const plan = bundle.latestPlan;
      if (!plan) throw new Error(`No plan found for incident ${String(args.incidentId)}`);
      return ctx.wrapAndLog({
        tool: "report.generate_action_plan", source: "computed", scenarioId: s.scenarioId,
        argsJson: args,
        data: {
          operationalPeriod: `${bundle.simTime} + 4h`,
          objectives: plan.objectives,
          assignmentsByTeam: groupActionsByTeam(plan),
          timePhases: plan.timePhases,
          commsPlan: plan.commsPlan,
          safetyMessage: plan.unresolvedRisks,
          note: "ICS-inspired formatting; not certified emergency-management software",
        },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "report.export_markdown",
    description:
      "Render the incident brief to markdown (fixed section order per plan/04 §3.9), persist it, and return reportId + markdown. Optional narrativeSections add agent-written connective text; all data comes from the DB.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      incidentId: z.string(),
      narrativeSections: z
        .object({
          executiveSummary: z.string().optional(),
          outlook: z.string().optional(),
        })
        .default({}),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const bundle = buildBundle(ctx, s.scenarioId, args.incidentId as string);
      const markdown = renderIncidentBrief(bundle, args.narrativeSections as { executiveSummary?: string; outlook?: string });
      const reportId = `rpt-${randomUUID()}`;
      ctx.db
        .prepare("INSERT INTO reports (id, incident_id, markdown, created_at) VALUES (?, ?, ?, ?)")
        .run(reportId, args.incidentId as string, markdown, new Date().toISOString());
      auditLog(ctx.db, {
        actor: "mcp:report.export_markdown",
        eventType: "report.generated",
        detail: { reportId, incidentId: args.incidentId, bytes: markdown.length },
      });
      return ctx.wrapAndLog({
        tool: "report.export_markdown", source: "computed", scenarioId: s.scenarioId,
        argsJson: { incidentId: args.incidentId },
        data: { reportId, markdown },
        startedMs: performance.now(),
      });
    },
  },
];

function groupActionsByTeam(plan: NonNullable<ReportBundle["latestPlan"]>) {
  const byTeam: Record<string, { title: string; timeWindow: string; tier: string }[]> = {};
  for (const a of plan.actions) {
    (byTeam[a.targetTeam] ??= []).push({ title: a.title, timeWindow: a.timeWindow, tier: a.tier });
  }
  return byTeam;
}
