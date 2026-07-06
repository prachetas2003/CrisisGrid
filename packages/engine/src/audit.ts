import { createHash } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Append-only, tamper-evident audit log (plan/09-safety-security.md §4).
 * Each row's content_hash = sha256(prev_hash + canonical row payload),
 * forming a verifiable chain. Every tier decision, approval, block,
 * publish, and scenario mutation lands here.
 */

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  eventType: string;
  detail: unknown;
  contentHash: string;
}

export function auditLog(
  db: Db,
  entry: { actor: string; eventType: string; detail: unknown },
  now: () => string = () => new Date().toISOString(),
): { auditId: number; contentHash: string } {
  const prev = db
    .prepare("SELECT content_hash FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { content_hash: string } | undefined;
  const prevHash = prev?.content_hash ?? "genesis";
  const ts = now();
  const detailJson = JSON.stringify(entry.detail ?? {});
  const contentHash = createHash("sha256")
    .update(`${prevHash}|${ts}|${entry.actor}|${entry.eventType}|${detailJson}`)
    .digest("hex");
  const result = db
    .prepare(
      "INSERT INTO audit_log (ts, actor, event_type, detail_json, content_hash) VALUES (?, ?, ?, ?, ?)",
    )
    .run(ts, entry.actor, entry.eventType, detailJson, contentHash);
  return { auditId: Number(result.lastInsertRowid), contentHash };
}

/** Recompute the chain and report the first broken link, if any. */
export function verifyAuditChain(db: Db): { ok: boolean; brokenAtId: number | null } {
  const rows = db
    .prepare("SELECT id, ts, actor, event_type, detail_json, content_hash FROM audit_log ORDER BY id")
    .all() as { id: number; ts: string; actor: string; event_type: string; detail_json: string; content_hash: string }[];
  let prevHash = "genesis";
  for (const r of rows) {
    const expected = createHash("sha256")
      .update(`${prevHash}|${r.ts}|${r.actor}|${r.event_type}|${r.detail_json}`)
      .digest("hex");
    if (expected !== r.content_hash) return { ok: false, brokenAtId: r.id };
    prevHash = r.content_hash;
  }
  return { ok: true, brokenAtId: null };
}
