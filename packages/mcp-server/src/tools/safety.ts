import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditLog } from "@crisisgrid/engine";
import { ProposedAction, evaluateAction } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { readState, scenarioArgs } from "./common.js";

/**
 * safety.* + audit.* — policy and audit tools (plan/05 §2, plan/09).
 * evaluate_action runs the SAME deterministic rule table the server's action
 * queue enforces — prompts are advisory, these rules are the guarantee.
 */

const proposedActionArg = {
  action: z.object({
    kind: ProposedAction.shape.kind,
    title: z.string(),
    description: z.string(),
    simulated: z.boolean().default(true),
    confidence: z.number().min(0).max(1).default(1),
    evidence: z.array(z.string()).default([]),
  }),
};

export const safetyTools: ToolDef[] = [
  {
    name: "safety.evaluate_action",
    description:
      "Deterministically classify a proposed action against the policy rule table (plan/09): returns tier (safe / needs_approval / blocked) and the matched rule with reason. Run this BEFORE recommending any action.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, ...proposedActionArg }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const action = ProposedAction.parse(args.action);
      const decision = evaluateAction(action);
      return ctx.wrapAndLog({
        tool: "safety.evaluate_action", source: "computed", scenarioId: s.scenarioId,
        argsJson: args,
        data: { tier: decision.tier, matchedRules: decision.matchedRules, action: { kind: action.kind, title: action.title } },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "safety.require_approval",
    description:
      "Enqueue a proposed action for human operator approval. Returns the actionId and queue status. The operator approves/rejects via the command center; agents CANNOT approve.",
    tier: "safe",
    source: "computed",
    input: z.object({ ...scenarioArgs, ...proposedActionArg, incidentId: z.string().optional() }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const action = ProposedAction.parse(args.action);
      const decision = evaluateAction(action);
      const actionId = `act-${randomUUID()}`;
      const status = decision.tier === "blocked" ? "blocked" : "queued";
      ctx.db
        .prepare(
          `INSERT INTO actions (id, plan_id, incident_id, kind, tier, status, payload_json, matched_rules_json, requested_by, blocked_reason, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
        )
        .run(
          actionId, (args.incidentId as string) ?? null, action.kind,
          decision.tier === "blocked" ? "blocked" : "needs_approval", status,
          JSON.stringify(action), JSON.stringify(decision.matchedRules),
          decision.tier === "blocked" ? decision.matchedRules[0]?.reason ?? "policy" : null,
          new Date().toISOString(),
        );
      auditLog(ctx.db, {
        actor: "mcp:safety.require_approval",
        eventType: status === "blocked" ? "action.blocked" : "action.queued",
        detail: { actionId, kind: action.kind, title: action.title, rules: decision.matchedRules },
      });
      const queued = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'queued'")
        .get() as { n: number };
      return ctx.wrapAndLog({
        tool: "safety.require_approval", source: "computed", scenarioId: s.scenarioId,
        argsJson: args,
        data: { actionId, status, tier: decision.tier, queuePosition: queued.n, matchedRules: decision.matchedRules },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "safety.record_approval",
    description:
      "BLOCKED FOR AGENTS: approvals are recorded only by the operator UI (POST /api/actions/:id/approve on the orchestration server). Exists in the catalog so the boundary is explicit and auditable.",
    tier: "blocked",
    source: "computed",
    actionKind: "dispatch",
    input: z.object({ actionId: z.string().optional(), decision: z.string().optional() }),
    handler: () => {
      throw new Error("unreachable: blocked tier");
    },
  },
  {
    name: "safety.block_action",
    description: "Record that an action was blocked, with reason and policy reference. Appends to the audit chain.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      actionTitle: z.string(),
      reason: z.string(),
      policyRef: z.string().default("R-99"),
      incidentId: z.string().optional(),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const actionId = `act-${randomUUID()}`;
      ctx.db
        .prepare(
          `INSERT INTO actions (id, plan_id, incident_id, kind, tier, status, payload_json, matched_rules_json, requested_by, blocked_reason, created_at)
           VALUES (?, NULL, ?, 'analysis', 'blocked', 'blocked', ?, ?, 'agent', ?, ?)`,
        )
        .run(
          actionId, (args.incidentId as string) ?? null,
          JSON.stringify({ title: args.actionTitle }),
          JSON.stringify([{ id: args.policyRef, reason: args.reason }]),
          args.reason as string, new Date().toISOString(),
        );
      const audit = auditLog(ctx.db, {
        actor: "mcp:safety.block_action",
        eventType: "action.blocked",
        detail: { actionId, title: args.actionTitle, reason: args.reason, policyRef: args.policyRef },
      });
      return ctx.wrapAndLog({
        tool: "safety.block_action", source: "computed", scenarioId: s.scenarioId,
        argsJson: args, data: { actionId, auditId: audit.auditId, contentHash: audit.contentHash },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "audit.log_event",
    description: "Append an event to the tamper-evident audit chain. Returns auditId and content hash.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      actor: z.string(),
      eventType: z.string(),
      detail: z.record(z.unknown()).default({}),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const audit = auditLog(ctx.db, {
        actor: args.actor as string,
        eventType: args.eventType as string,
        detail: args.detail,
      });
      return ctx.wrapAndLog({
        tool: "audit.log_event", source: "computed", scenarioId: s.scenarioId,
        argsJson: args, data: audit, startedMs: performance.now(),
      });
    },
  },
];
