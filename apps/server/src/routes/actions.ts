import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, verifyAuditChain, type Db } from "@crisisgrid/engine";
import { approvalSecret, mintApprovalToken } from "@crisisgrid/shared";
import { executeTool, REGISTRY, type ToolContext } from "@crisisgrid/mcp-server";
import { broadcast } from "../sse/bus.js";
import { requireRole } from "../security/auth.js";

/**
 * Human approval action queue (plan/09-safety-security.md §3).
 * Operators approve/reject here. On approve the server mints a single-use
 * token and immediately executes the underlying tool through the same
 * tier-enforced choke point agents use. Agents never see tokens.
 */

export function actionRoutes(app: FastifyInstance, db: Db, toolCtx: ToolContext): void {
  app.get("/api/actions", async (req) => {
    const { status } = z
      .object({ status: z.enum(["queued", "approved", "rejected", "executed", "blocked"]).optional() })
      .parse(req.query);
    const rows = db
      .prepare(
        `SELECT id, kind, tier, status, payload_json, matched_rules_json, requested_by,
                approved_by, approved_at, executed_at, blocked_reason, created_at
         FROM actions ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...(status ? [status] : [])) as Record<string, unknown>[];
    return {
      actions: rows.map((r) => ({
        ...r,
        payload: JSON.parse(r.payload_json as string),
        matchedRules: JSON.parse(r.matched_rules_json as string),
        payload_json: undefined,
        matched_rules_json: undefined,
      })),
    };
  });

  app.post("/api/actions/:id/approve", { preHandler: requireRole("operator") }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { operator } = z.object({ operator: z.string().min(1) }).parse(req.body);

    const row = db
      .prepare("SELECT id, status, tier, payload_json FROM actions WHERE id = ?")
      .get(id) as { id: string; status: string; tier: string; payload_json: string } | undefined;
    if (!row) return reply.code(404).send({ error: "unknown action" });
    if (row.tier !== "needs_approval") return reply.code(400).send({ error: `action tier is ${row.tier}` });
    if (row.status !== "queued") return reply.code(409).send({ error: `action is ${row.status}` });

    db.prepare("UPDATE actions SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?")
      .run(operator, new Date().toISOString(), id);
    auditLog(db, { actor: `operator:${operator}`, eventType: "action.approved", detail: { actionId: id } });
    broadcast({ type: "action.approved", payload: { actionId: id, operator } });

    // Execute the underlying tool with a fresh single-use token, if the
    // queued action wraps a tool call (agent-initiated approval requests may not).
    const payload = JSON.parse(row.payload_json) as { tool?: string; args?: Record<string, unknown> };
    if (payload.tool && payload.args) {
      const token = mintApprovalToken(id, approvalSecret(), Date.now());
      const outcome = await executeTool(toolCtx, payload.tool, { ...payload.args, approvalToken: token });
      broadcast({ type: "action.executed", payload: { actionId: id, tool: payload.tool } });
      return { actionId: id, status: "executed", outcome };
    }
    return { actionId: id, status: "approved", note: "No wrapped tool call; recorded approval only" };
  });

  app.post("/api/actions/:id/reject", { preHandler: requireRole("operator") }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { operator, reason } = z
      .object({ operator: z.string().min(1), reason: z.string().default("rejected by operator") })
      .parse(req.body);
    const row = db.prepare("SELECT id, status FROM actions WHERE id = ?").get(id) as
      | { id: string; status: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "unknown action" });
    if (row.status !== "queued") return reply.code(409).send({ error: `action is ${row.status}` });
    db.prepare("UPDATE actions SET status = 'rejected', approved_by = ?, approved_at = ?, blocked_reason = ? WHERE id = ?")
      .run(operator, new Date().toISOString(), reason, id);
    auditLog(db, { actor: `operator:${operator}`, eventType: "action.rejected", detail: { actionId: id, reason } });
    broadcast({ type: "action.rejected", payload: { actionId: id, operator, reason } });
    return { actionId: id, status: "rejected" };
  });

  app.get("/api/audit", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = db
      .prepare("SELECT id, ts, actor, event_type, detail_json, content_hash FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return {
      chain: verifyAuditChain(db),
      entries: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail_json as string), detail_json: undefined })),
    };
  });

  app.get("/api/feed", async () => {
    const rows = db
      .prepare("SELECT id, draft_id, channel, body, published_at, watermark FROM sandbox_feed ORDER BY id DESC LIMIT 50")
      .all() as Record<string, unknown>[];
    return { feed: rows, note: "SANDBOX demo feed — no real alerts are ever sent" };
  });

  app.get("/api/comms/drafts", async () => {
    const rows = db
      .prepare(
        `SELECT draft_id, incident_id, channel, audience, urgency, body, validated, issues_json, created_at
         FROM comms_drafts ORDER BY created_at DESC LIMIT 50`,
      )
      .all() as Record<string, unknown>[];
    return {
      drafts: rows.map((r) => ({
        draftId: r.draft_id,
        incidentId: r.incident_id,
        channel: r.channel,
        audience: r.audience,
        urgency: r.urgency,
        body: r.body,
        validated: r.validated === 1,
        issues: JSON.parse((r.issues_json as string) ?? "[]"),
        createdAt: r.created_at,
      })),
    };
  });

  /**
   * Queue a validated draft for publication. Goes through the exact same
   * tier-enforced choke point agents use: this returns PENDING_APPROVAL and
   * the operator still has to approve the queued action to publish.
   */
  app.post("/api/comms/drafts/:draftId/queue", { preHandler: requireRole("operator") }, async (req, reply) => {
    const { draftId } = z.object({ draftId: z.string() }).parse(req.params);
    const outcome = await executeTool(toolCtx, "comms.send_sandbox_alert", { draftId });
    if (outcome.kind !== "pending_approval") {
      return reply.code(422).send({ error: `expected pending_approval, got ${outcome.kind}`, detail: outcome });
    }
    broadcast({ type: "action.queued", payload: { actionId: outcome.actionId, tool: "comms.send_sandbox_alert" } });
    return { actionId: outcome.actionId, status: "queued" };
  });

  /** Render the handoff report for an incident through the same MCP tool agents use. */
  app.post("/api/incidents/:id/report", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const outcome = await executeTool(toolCtx, "report.export_markdown", { incidentId: id });
    if (outcome.kind !== "ok") {
      return reply.code(422).send({ error: `report generation ${outcome.kind}`, detail: outcome });
    }
    const envelope = outcome.result as { data?: { reportId?: string; markdown?: string } };
    const data = envelope.data ?? {};
    return { reportId: data.reportId ?? `report-${id}`, markdown: data.markdown ?? "" };
  });

  /** Judge Mode data: full MCP tool catalog + eval summary + live health. */
  app.get("/api/judge/info", async () => {
    return {
      tools: REGISTRY.map((t) => ({
        name: t.name,
        tier: t.tier,
        source: t.source,
        description: t.description,
      })),
      evals: { files: 7, tests: 47 },
      health: {
        service: "crisisgrid-server",
        auditChain: verifyAuditChain(db),
        generatedAt: new Date().toISOString(),
      },
    };
  });
}
