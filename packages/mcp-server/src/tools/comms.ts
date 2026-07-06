import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditLog } from "@crisisgrid/engine";
import { BANNED_COMMS_PHRASES, SMS_MAX_CHARS } from "@crisisgrid/shared";
import type { ToolDef } from "../registry.js";
import { readState, scenarioArgs } from "./common.js";
import { demoMode } from "../adapters/openMeteo.js";

/**
 * comms.* — communication tools (plan/05 §2).
 * Drafting is safe (validation only). Publishing is approval-tier and only
 * ever reaches the in-app sandbox feed, watermarked SIMULATED.
 * comms.broadcast_all_channels exists to be refused (blocked tier) —
 * the structural stand-in for real emergency broadcast.
 */

const WATERMARK = "THIS IS A SIMULATED EXERCISE";

function validateBody(channel: string, body: string): string[] {
  const issues: string[] = [];
  if (body.trim().length === 0) issues.push("Body is empty");
  if (channel === "sms" && body.length > SMS_MAX_CHARS)
    issues.push(`SMS body is ${body.length} chars; limit is ${SMS_MAX_CHARS}`);
  for (const phrase of BANNED_COMMS_PHRASES) {
    if (body.toLowerCase().includes(phrase)) issues.push(`Banned phrase for public comms: "${phrase}"`);
  }
  if (demoMode() && !body.includes(WATERMARK))
    issues.push(`Demo mode requires the watermark line: "${WATERMARK}"`);
  return issues;
}

export const commsTools: ToolDef[] = [
  {
    name: "comms.draft_public_alert",
    description:
      `Validate and store a public alert draft (sms/social/email). Checks channel length limits, banned authority phrases, and the required "${WATERMARK}" watermark in demo mode. Returns draftId + issues. Drafting never publishes — publishing requires operator approval via comms.send_sandbox_alert.`,
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      channel: z.enum(["sms", "social", "email"]),
      audience: z.string().default("public"),
      urgency: z.enum(["advisory", "watch", "warning"]).default("warning"),
      body: z.string(),
      factsUsed: z.array(z.string()).default([]),
      incidentId: z.string().optional(),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const issues = validateBody(args.channel as string, args.body as string);
      const draftId = `draft-${randomUUID()}`;
      ctx.db
        .prepare(
          `INSERT INTO comms_drafts (draft_id, incident_id, channel, audience, urgency, body, facts_used_json, validated, issues_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          draftId, (args.incidentId as string) ?? null, args.channel as string,
          args.audience as string, args.urgency as string, args.body as string,
          JSON.stringify(args.factsUsed), issues.length === 0 ? 1 : 0,
          JSON.stringify(issues), new Date().toISOString(),
        );
      return ctx.wrapAndLog({
        tool: "comms.draft_public_alert", source: "computed", scenarioId: s.scenarioId,
        argsJson: { ...args, body: `${(args.body as string).slice(0, 80)}…` },
        data: { draftId, validated: issues.length === 0, issues, approvalRequired: true },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "comms.draft_internal_update",
    description:
      "Validate and store an internal operations update for a named team (utility_ops, traffic_control, shelter_ops, public_safety, communications). Sending requires operator approval.",
    tier: "safe",
    source: "computed",
    input: z.object({
      ...scenarioArgs,
      audienceTeam: z.string(),
      body: z.string(),
      incidentId: z.string().optional(),
    }),
    handler: (args, ctx) => {
      const s = readState(ctx, args);
      const issues = (args.body as string).trim().length === 0 ? ["Body is empty"] : [];
      const draftId = `draft-${randomUUID()}`;
      ctx.db
        .prepare(
          `INSERT INTO comms_drafts (draft_id, incident_id, channel, audience, urgency, body, facts_used_json, validated, issues_json, created_at)
           VALUES (?, ?, 'internal', ?, 'advisory', ?, '[]', ?, ?, ?)`,
        )
        .run(
          draftId, (args.incidentId as string) ?? null, args.audienceTeam as string,
          args.body as string, issues.length === 0 ? 1 : 0, JSON.stringify(issues),
          new Date().toISOString(),
        );
      return ctx.wrapAndLog({
        tool: "comms.draft_internal_update", source: "computed", scenarioId: s.scenarioId,
        argsJson: { ...args, body: `${(args.body as string).slice(0, 80)}…` },
        data: { draftId, validated: issues.length === 0, issues, approvalRequired: true },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "comms.send_sandbox_alert",
    description:
      "Publish a validated draft to the in-app SANDBOX demo feed (watermarked SIMULATED). Approval-tier: without an operator-minted approvalToken this only enqueues the action and returns PENDING_APPROVAL.",
    tier: "approval",
    source: "computed",
    actionKind: "public_comms",
    input: z.object({
      ...scenarioArgs,
      draftId: z.string(),
      approvalToken: z.string().optional(),
    }),
    handler: (args, ctx) => {
      // Reached only after the tier middleware verified + spent the token.
      const s = readState(ctx, args);
      const draft = ctx.db
        .prepare("SELECT draft_id, channel, body, validated FROM comms_drafts WHERE draft_id = ?")
        .get(args.draftId) as { draft_id: string; channel: string; body: string; validated: number } | undefined;
      if (!draft) throw new Error(`Unknown draft ${String(args.draftId)}`);
      if (draft.validated !== 1) throw new Error("Draft failed validation; fix issues and re-draft");
      const publishedAt = new Date().toISOString();
      ctx.db
        .prepare(
          "INSERT INTO sandbox_feed (draft_id, action_id, channel, body, published_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(draft.draft_id, (args.__actionId as string) ?? "direct", draft.channel, draft.body, publishedAt);
      auditLog(ctx.db, {
        actor: "mcp:comms.send_sandbox_alert",
        eventType: "comms.published_sandbox",
        detail: { draftId: draft.draft_id, channel: draft.channel },
      });
      return ctx.wrapAndLog({
        tool: "comms.send_sandbox_alert", source: "computed", scenarioId: s.scenarioId,
        argsJson: { draftId: args.draftId },
        data: { publishedAt, feed: "sandbox", watermark: "SIMULATED EXERCISE", label: "SIMULATED" },
        startedMs: performance.now(),
      });
    },
  },
  {
    name: "comms.broadcast_all_channels",
    description:
      "BLOCKED BY POLICY (R-06): stand-in for real emergency broadcast. Always refuses with a structured policy reference and an audit entry. Use comms.send_sandbox_alert with operator approval instead.",
    tier: "blocked",
    source: "computed",
    actionKind: "broadcast",
    input: z.object({ ...scenarioArgs, body: z.string().optional() }),
    handler: () => {
      // Never reached — the tier middleware refuses blocked tools structurally.
      throw new Error("unreachable: blocked tier");
    },
  },
];
