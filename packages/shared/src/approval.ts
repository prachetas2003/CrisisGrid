import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Single-use approval tokens (plan/09-safety-security.md §3).
 * Minted ONLY by the orchestration server when an operator clicks Approve.
 * Spent ONLY by tool executors. Agents never see or hold tokens — a
 * misbehaving agent physically cannot execute an approval-tier action.
 *
 * Format: <actionId>.<expiresAtMs>.<hmacHex>
 * hmac = HMAC-SHA256(secret, `${actionId}.${expiresAtMs}`)
 * Single-use is enforced by the actions.token_used_at column at spend time.
 */

export const APPROVAL_TOKEN_TTL_MS = 15 * 60 * 1000;

export function mintApprovalToken(actionId: string, secret: string, nowMs: number): string {
  const expiresAt = nowMs + APPROVAL_TOKEN_TTL_MS;
  const sig = sign(`${actionId}.${expiresAt}`, secret);
  return `${actionId}.${expiresAt}.${sig}`;
}

export type TokenCheck =
  | { ok: true; actionId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" | "wrong_action" };

export function verifyApprovalToken(
  token: string,
  secret: string,
  nowMs: number,
  expectedActionId?: string,
): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [actionId, expiresAtStr, sig] = parts as [string, string, string];
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "malformed" };
  const expected = sign(`${actionId}.${expiresAt}`, secret);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  if (nowMs > expiresAt) return { ok: false, reason: "expired" };
  if (expectedActionId && actionId !== expectedActionId) return { ok: false, reason: "wrong_action" };
  return { ok: true, actionId };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function approvalSecret(): string {
  const s = process.env.SERVER_SECRET;
  if (s && s.length >= 16) return s;
  // Dev fallback keeps local demos working; production deploys set SERVER_SECRET.
  return "crisisgrid-dev-secret-not-for-production";
}
