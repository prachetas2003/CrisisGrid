import { beforeAll, describe, expect, it } from "vitest";
import { ToolContext, executeTool } from "@crisisgrid/mcp-server";
import { approvalSecret, mintApprovalToken, verifyApprovalToken } from "@crisisgrid/shared";
import { verifyAuditChain } from "@crisisgrid/engine";
import type { ToolResultEnvelope } from "@crisisgrid/shared";

/**
 * Eval 9 — approval gate enforcement (plan/10).
 * Asserts the STRUCTURAL guarantee: approval-tier tools cannot execute
 * without an operator-minted, single-use, HMAC-signed token, regardless of
 * what any agent says. Runs against the real tool execution choke point.
 */

const SMS_BODY =
  "Flood risk rising near Westbrook. If you are in low-lying areas west of the river, " +
  "move to Eastgate Community Center, 200 SE Main St. Avoid Route 12 after 6:40 PM. " +
  "THIS IS A SIMULATED EXERCISE";

let ctx: ToolContext;

function ok(outcome: Awaited<ReturnType<typeof executeTool>>): ToolResultEnvelope {
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.result as ToolResultEnvelope;
}

beforeAll(() => {
  ctx = new ToolContext(":memory:");
  ctx.engine.load("westside-cascade");
  ctx.engine.tick("westside-cascade", 6); // outage + closure active
});

describe("eval 9 — approval-tier tools are structurally gated", () => {
  let draftId: string;
  let actionId: string;

  it("drafting (safe tier) works and validates the sandbox watermark", async () => {
    const env = ok(
      await executeTool(ctx, "comms.draft_public_alert", { channel: "sms", body: SMS_BODY }),
    );
    const data = env.data as { draftId: string; validated: boolean; issues: string[] };
    expect(data.validated).toBe(true);
    expect(data.issues).toEqual([]);
    draftId = data.draftId;

    // Banned phrase + missing watermark are caught.
    const bad = ok(
      await executeTool(ctx, "comms.draft_public_alert", {
        channel: "sms",
        body: "Mandatory evacuation ordered by the mayor.",
      }),
    );
    const badData = bad.data as { validated: boolean; issues: string[] };
    expect(badData.validated).toBe(false);
    expect(badData.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("publishing WITHOUT a token only enqueues (PENDING_APPROVAL), publishes nothing", async () => {
    const outcome = await executeTool(ctx, "comms.send_sandbox_alert", { draftId });
    expect(outcome.kind).toBe("pending_approval");
    if (outcome.kind !== "pending_approval") return;
    actionId = outcome.actionId;

    const row = ctx.db.prepare("SELECT status, tier FROM actions WHERE id = ?").get(actionId) as {
      status: string;
      tier: string;
    };
    expect(row).toMatchObject({ status: "queued", tier: "needs_approval" });
    const feed = ctx.db.prepare("SELECT COUNT(*) AS n FROM sandbox_feed").get() as { n: number };
    expect(feed.n).toBe(0);
  });

  it("a forged token is refused and audited", async () => {
    const forged = mintApprovalToken(actionId, "attacker-secret-1234567890", Date.now());
    await expect(
      executeTool(ctx, "comms.send_sandbox_alert", { draftId, approvalToken: forged }),
    ).rejects.toThrow(/bad_signature/);
    const audit = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'approval.token_rejected'")
      .get() as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(1);
  });

  it("an expired token is refused", () => {
    const token = mintApprovalToken(actionId, approvalSecret(), Date.now() - 60 * 60 * 1000);
    const check = verifyApprovalToken(token, approvalSecret(), Date.now());
    expect(check).toMatchObject({ ok: false, reason: "expired" });
  });

  it("a token for an action that is not operator-approved is refused", async () => {
    const token = mintApprovalToken(actionId, approvalSecret(), Date.now());
    await expect(
      executeTool(ctx, "comms.send_sandbox_alert", { draftId, approvalToken: token }),
    ).rejects.toThrow(/queued, not approved/);
  });

  it("operator approval + valid token executes exactly once (single-use)", async () => {
    // Simulate the server's approve route: mark approved, mint token.
    ctx.db
      .prepare("UPDATE actions SET status = 'approved', approved_by = 'eval-operator', approved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), actionId);
    const token = mintApprovalToken(actionId, approvalSecret(), Date.now());

    const env = ok(await executeTool(ctx, "comms.send_sandbox_alert", { draftId, approvalToken: token }));
    expect((env.data as { feed: string }).feed).toBe("sandbox");

    const feed = ctx.db.prepare("SELECT body, watermark FROM sandbox_feed").all() as { body: string; watermark: string }[];
    expect(feed).toHaveLength(1);
    expect(feed[0]!.body).toContain("SIMULATED EXERCISE");
    expect(feed[0]!.watermark).toBe("SIMULATED EXERCISE");

    // Replay the same token — refused (status already 'executed' and the
    // single-use token is spent), nothing published twice.
    await expect(
      executeTool(ctx, "comms.send_sandbox_alert", { draftId, approvalToken: token }),
    ).rejects.toThrow(/executed, not approved|already used/);
    const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM sandbox_feed").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("blocked tools always refuse with a policy reference and audit entry", async () => {
    for (const tool of ["comms.broadcast_all_channels", "safety.record_approval"]) {
      const outcome = await executeTool(ctx, tool, {});
      expect(outcome.kind).toBe("blocked");
      if (outcome.kind === "blocked") expect(outcome.policyRef).toMatch(/^R-\d\d$/);
    }
    const blocked = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'action.blocked'")
      .get() as { n: number };
    expect(blocked.n).toBeGreaterThanOrEqual(2);
  });

  it("scenario mutation (sim.advance_time) is gated the same way", async () => {
    const before = ctx.engine.currentTick("westside-cascade");
    const pending = await executeTool(ctx, "sim.advance_time", { ticks: 2 });
    expect(pending.kind).toBe("pending_approval");
    expect(ctx.engine.currentTick("westside-cascade")).toBe(before); // unchanged

    if (pending.kind !== "pending_approval") return;
    ctx.db.prepare("UPDATE actions SET status = 'approved', approved_by = 'eval-operator' WHERE id = ?").run(pending.actionId);
    const token = mintApprovalToken(pending.actionId, approvalSecret(), Date.now());
    ok(await executeTool(ctx, "sim.advance_time", { ticks: 2, approvalToken: token }));
    expect(ctx.engine.currentTick("westside-cascade")).toBe(before + 2);
  });

  it("shelter assignment validates capacity and rejects overflow with remainder", async () => {
    const pending = await executeTool(ctx, "shelters.assign_population", {
      assignments: [
        { zone: "Z-05", shelterId: "SHL-LHS", count: 200 },
        { zone: "Z-06", shelterId: "SHL-LHS", count: 99999 },
      ],
    });
    expect(pending.kind).toBe("pending_approval");
    if (pending.kind !== "pending_approval") return;

    // The dry-run preview already exposes the overflow rejection.
    const preview = pending.preview as {
      accepted: { count: number }[];
      rejected: { remainder: number; reason: string }[];
    };
    expect(preview.rejected.length).toBeGreaterThanOrEqual(1);
    expect(preview.rejected[preview.rejected.length - 1]!.remainder).toBeGreaterThan(0);

    ctx.db.prepare("UPDATE actions SET status = 'approved', approved_by = 'eval-operator' WHERE id = ?").run(pending.actionId);
    const token = mintApprovalToken(pending.actionId, approvalSecret(), Date.now());
    const env = ok(
      await executeTool(ctx, "shelters.assign_population", {
        assignments: [
          { zone: "Z-05", shelterId: "SHL-LHS", count: 200 },
          { zone: "Z-06", shelterId: "SHL-LHS", count: 99999 },
        ],
        approvalToken: token,
      }),
    );
    const data = env.data as { accepted: { count: number }[]; rejected: unknown[]; applied: boolean };
    expect(data.applied).toBe(true);
    expect(data.rejected.length).toBeGreaterThanOrEqual(1);

    // Occupancy actually moved, but never beyond capacity.
    const shelters = ok(await executeTool(ctx, "shelters.list", {}));
    const eastgate = (shelters.data as { shelters: { id: string; occupied: number; capacity: number }[] }).shelters
      .find((s) => s.id === "SHL-LHS")!;
    expect(eastgate.occupied).toBeLessThanOrEqual(eastgate.capacity);
    expect(eastgate.occupied).toBeGreaterThanOrEqual(200);
  });

  it("the audit hash chain verifies end-to-end", () => {
    expect(verifyAuditChain(ctx.db)).toEqual({ ok: true, brokenAtId: null });
    // Tamper with one row → chain breaks at that row.
    ctx.db.prepare("UPDATE audit_log SET detail_json = '{\"tampered\":true}' WHERE id = 2").run();
    const broken = verifyAuditChain(ctx.db);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtId).toBe(2);
  });
});
