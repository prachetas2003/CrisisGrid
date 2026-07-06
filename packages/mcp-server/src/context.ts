import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioEngine, openDb, type Db } from "@crisisgrid/engine";
import type { ToolResultEnvelope, ToolSource } from "@crisisgrid/shared";

/**
 * Tool execution context. The MCP server shares the SQLite DB with the
 * orchestration server (WAL mode, cross-process safe). Scenario-source tools
 * read entity state at the current (or fork) tick through the engine —
 * agents never see future timeline events (plan/06 §5).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export class ToolContext {
  readonly db: Db;
  readonly engine: ScenarioEngine;

  constructor(dbPath?: string) {
    // Relative paths resolve against the repo root, never the process cwd,
    // so every service opens the SAME database no matter where it launched.
    const requested = dbPath ?? process.env.DATABASE_PATH ?? join(REPO_ROOT, "data", "crisisgrid.sqlite");
    const resolved =
      requested === ":memory:" || isAbsolute(requested) ? requested : join(REPO_ROOT, requested);
    this.db = openDb(resolved);
    this.engine = new ScenarioEngine(this.db, join(REPO_ROOT, "scenarios"));
  }

  /** Default scenario = the single loaded one; explicit id wins. */
  resolveScenario(scenarioId?: string): string {
    if (scenarioId) return scenarioId;
    const rows = this.db.prepare("SELECT id FROM scenarios ORDER BY loaded_at DESC").all() as {
      id: string;
    }[];
    if (rows.length === 0) throw new Error("No scenario loaded. Call sim.load_scenario first.");
    return rows[0]!.id;
  }

  /**
   * Wrap a tool result in the evidence envelope (plan/05 §1) and log the call
   * to tool_calls — this row is what agents cite as evidence and what
   * eval 13 (no bypass) audits.
   */
  wrapAndLog(args: {
    tool: string;
    source: ToolSource;
    scenarioId: string | null;
    argsJson: unknown;
    data: unknown;
    startedMs: number;
    provider?: string;
    freshness?: ToolResultEnvelope["freshness"];
    note?: string;
  }): ToolResultEnvelope {
    const toolCallId = `tc-${randomUUID()}`;
    const asOf = args.scenarioId
      ? this.engine.simTimeAt(args.scenarioId, this.engine.currentTick(args.scenarioId))
      : new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, incident_id, agent_id, tool, args_json, result_digest, source, latency_ms, ts)
         VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toolCallId,
        args.tool,
        JSON.stringify(args.argsJson),
        digest(args.data),
        args.source,
        Math.max(0, Math.round(performance.now() - args.startedMs)),
        new Date().toISOString(),
      );
    return {
      toolCallId,
      source: args.source,
      asOf,
      data: args.data,
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.freshness ? { freshness: args.freshness } : {}),
      ...(args.note ? { note: args.note } : {}),
    };
  }
}

function digest(data: unknown): string {
  const s = JSON.stringify(data);
  return s.length <= 200 ? s : `${s.slice(0, 200)}… (${s.length} chars)`;
}
