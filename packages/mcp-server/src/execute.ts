import { randomUUID } from "node:crypto";
import { auditLog } from "@crisisgrid/engine";
import { approvalSecret, verifyApprovalToken } from "@crisisgrid/shared";
import type { ToolContext } from "./context.js";
import { REGISTRY, type ToolDef } from "./registry.js";

/**
 * The single execution choke point for every tool call (plan/09 §2, Layer 4).
 * Used by both the MCP stdio server (agent calls) and the orchestration
 * server (operator-approved executions). Tier enforcement lives HERE, in
 * code — a prompt-injected agent cannot bypass it because there is no other
 * code path to a tool handler.
 */

export type ExecuteResult =
  | { kind: "ok"; result: unknown }
  | {
      kind: "pending_approval";
      actionId: string;
      tool: string;
      preview: unknown;
      note: string;
    }
  | { kind: "blocked"; tool: string; reason: string; policyRef: string; auditId: number };

export function findTool(name: string): ToolDef | undefined {
  const dotted = name.replaceAll("_", ".");
  return REGISTRY.find((t) => t.name === name || t.name === dotted || t.name.replaceAll(".", "_") === name);
}

export async function executeTool(
  ctx: ToolContext,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<ExecuteResult> {
  const tool = findTool(toolName);
  if (!tool) throw new Error(`Unknown tool ${toolName}`);
  const args = tool.input.parse(rawArgs ?? {});

  // ---- blocked tier: structured refusal, always audited -------------------
  if (tool.tier === "blocked") {
    const policyRef = tool.actionKind === "broadcast" ? "R-06" : "R-02";
    const reason = `Tool ${tool.name} is blocked by policy: ${tool.description.split(".")[0]}`;
    const audit = auditLog(ctx.db, {
      actor: `mcp:${tool.name}`,
      eventType: "action.blocked",
      detail: { tool: tool.name, args: summarize(args), policyRef },
    });
    return { kind: "blocked", tool: tool.name, reason, policyRef, auditId: audit.auditId };
  }

  // ---- approval tier: token or queue ---------------------------------------
  if (tool.tier === "approval") {
    const token = args.approvalToken as string | undefined;
    if (!token) {
      const actionId = `act-${randomUUID()}`;
      const preview = safePreview(tool, args, ctx);
      ctx.db
        .prepare(
          `INSERT INTO actions (id, plan_id, incident_id, kind, tier, status, payload_json, matched_rules_json, requested_by, created_at)
           VALUES (?, NULL, ?, ?, 'needs_approval', 'queued', ?, '[]', 'agent', ?)`,
        )
        .run(
          actionId,
          (args.incidentId as string) ?? null,
          tool.actionKind ?? "recommendation",
          JSON.stringify({ tool: tool.name, args, title: `${tool.name} requested`, preview }),
          new Date().toISOString(),
        );
      auditLog(ctx.db, {
        actor: `mcp:${tool.name}`,
        eventType: "action.queued",
        detail: { actionId, tool: tool.name, args: summarize(args) },
      });
      return {
        kind: "pending_approval",
        actionId,
        tool: tool.name,
        preview,
        note: "Operator approval required. Include this actionId in your plan; do NOT retry or work around the gate.",
      };
    }

    // Verify signature/expiry, bind to a queued+approved action, enforce single use.
    const check = verifyApprovalToken(token, approvalSecret(), Date.now());
    if (!check.ok) {
      auditLog(ctx.db, {
        actor: `mcp:${tool.name}`,
        eventType: "approval.token_rejected",
        detail: { tool: tool.name, reason: check.reason },
      });
      throw new Error(`Approval token rejected: ${check.reason}`);
    }
    const row = ctx.db
      .prepare("SELECT id, status, token_used_at FROM actions WHERE id = ?")
      .get(check.actionId) as { id: string; status: string; token_used_at: string | null } | undefined;
    if (!row) throw new Error("Approval token references an unknown action");
    if (row.status !== "approved") throw new Error(`Action ${row.id} is ${row.status}, not approved`);
    if (row.token_used_at) {
      auditLog(ctx.db, {
        actor: `mcp:${tool.name}`,
        eventType: "approval.token_reuse_refused",
        detail: { actionId: row.id },
      });
      throw new Error("Approval token already used (single-use)");
    }
    ctx.db
      .prepare("UPDATE actions SET token_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);

    const result = await tool.handler({ ...args, __actionId: row.id }, ctx);
    ctx.db
      .prepare("UPDATE actions SET status = 'executed', executed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    auditLog(ctx.db, {
      actor: `mcp:${tool.name}`,
      eventType: "action.executed",
      detail: { actionId: row.id, tool: tool.name },
    });
    return { kind: "ok", result };
  }

  // ---- safe tier ------------------------------------------------------------
  const result = await tool.handler(args, ctx);
  return { kind: "ok", result };
}

function safePreview(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): unknown {
  if (!tool.preview) return null;
  try {
    return tool.preview(args, ctx);
  } catch (err) {
    return { previewError: err instanceof Error ? err.message : String(err) };
  }
}

function summarize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "approvalToken") continue; // never log tokens
    const s = JSON.stringify(v);
    out[k] = s && s.length > 120 ? `${s.slice(0, 120)}…` : v;
  }
  return out;
}
