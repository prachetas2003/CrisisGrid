import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

/**
 * SQLite persistence (plan/03-architecture.md §6).
 * One file-based DB shared by server, MCP server, and CLI.
 * scenario_state is append-only per tick: past ticks are never rewritten,
 * which gives free replay and timeline scrubbing.
 */

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

const DDL = `
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  current_tick INTEGER NOT NULL DEFAULT 0,
  start_sim_time TEXT NOT NULL,
  minutes_per_tick INTEGER NOT NULL,
  loaded_at TEXT NOT NULL
);

-- fork_id = '' for the live timeline; what-if forks get their own id.
CREATE TABLE IF NOT EXISTS scenario_state (
  scenario_id TEXT NOT NULL,
  fork_id TEXT NOT NULL DEFAULT '',
  tick INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (scenario_id, fork_id, tick, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS scenario_events (
  scenario_id TEXT NOT NULL,
  fork_id TEXT NOT NULL DEFAULT '',
  tick INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  announcement TEXT NOT NULL,
  PRIMARY KEY (scenario_id, fork_id, tick, event_id)
);

CREATE TABLE IF NOT EXISTS forks (
  fork_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  base_tick INTEGER NOT NULL,
  event_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  operator_text TEXT NOT NULL,
  parsed_json TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  finding_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS debates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  stance TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  risk_score REAL NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  incident_id TEXT,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('safe','needs_approval','blocked')),
  status TEXT NOT NULL CHECK (status IN ('queued','approved','rejected','executed','blocked')),
  payload_json TEXT NOT NULL,
  matched_rules_json TEXT NOT NULL DEFAULT '[]',
  requested_by TEXT NOT NULL DEFAULT 'system',
  approved_by TEXT,
  approved_at TEXT,
  token_used_at TEXT,
  executed_at TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comms_drafts (
  draft_id TEXT PRIMARY KEY,
  incident_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('sms','social','email','internal')),
  audience TEXT NOT NULL,
  urgency TEXT NOT NULL,
  body TEXT NOT NULL,
  facts_used_json TEXT NOT NULL DEFAULT '[]',
  validated INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- The in-app "public feed" — the only place alerts ever publish (plan/09 §5).
CREATE TABLE IF NOT EXISTS sandbox_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL,
  watermark TEXT NOT NULL DEFAULT 'SIMULATED EXERCISE'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  incident_id TEXT,
  agent_id TEXT,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  source TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_cache (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('fresh','stale','fallback','error','unknown')),
  payload_json TEXT NOT NULL,
  raw_digest TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_lookup
  ON scenario_state (scenario_id, fork_id, tick, entity_type);

CREATE INDEX IF NOT EXISTS idx_provider_cache_domain
  ON provider_cache (domain, provider, status);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = createDb(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  return db;
}

export function defaultDbPath(): string {
  return process.env.DATABASE_PATH ?? "./data/crisisgrid.sqlite";
}

function createDb(path: string): Db {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (filename: string) => NodeSqliteDatabase;
    };
    return new NodeSqliteDb(new DatabaseSync(path));
  } catch {
    const BetterSqlite = createRequire(import.meta.url)("better-sqlite3") as {
      default?: new (filename: string) => Db;
      new (filename: string): Db;
    };
    const Database = BetterSqlite.default ?? BetterSqlite;
    return new Database(path);
  }
}

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

class NodeSqliteDb implements Db {
  constructor(private readonly db: NodeSqliteDatabase) {}

  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string): unknown {
    return this.db.prepare(`PRAGMA ${sql}`).all();
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return ((...args: Parameters<T>) => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }) as T;
  }

  close(): void {
    this.db.close();
  }
}
