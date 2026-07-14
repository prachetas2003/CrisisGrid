import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioEngine, defaultDbPath, openDb, type Db } from "@crisisgrid/engine";
import { ToolContext } from "@crisisgrid/mcp-server";
import { addClient, broadcast, clientCount } from "./sse/bus.js";
import { scenarioRoutes } from "./routes/scenario.js";
import { actionRoutes } from "./routes/actions.js";
import { incidentRoutes } from "./routes/incidents.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { mapRoutes } from "./routes/map.js";
import { opsRoutes } from "./routes/ops.js";
import { startProviderScheduler } from "./providers/scheduler.js";
import { authStatus } from "./security/auth.js";

/**
 * CrisisGrid orchestration host (plan/03-architecture.md).
 * Scenario engine surface + SSE stream + incident runs (→ ADK agent
 * service) + human-approval action queue + tamper-evident audit log.
 *
 * Production (Railway): one Fastify process binds process.env.PORT,
 * serves /api/* and the built React app from apps/web/dist.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCENARIOS_ROOT = join(REPO_ROOT, "scenarios");
const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");
const DEFAULT_SCENARIO_ID = "westside-cascade";

// Relative DATABASE_PATH always resolves against the repo root — never the
// process cwd — so the server, MCP server, and CLI share one database.
const envDbPath = process.env.DATABASE_PATH;
const dbPath = envDbPath
  ? isAbsolute(envDbPath)
    ? envDbPath
    : join(REPO_ROOT, envDbPath)
  : join(REPO_ROOT, "data", "crisisgrid.sqlite");

const app = Fastify({ logger: true });

app.log.info(
  {
    repoRoot: REPO_ROOT,
    scenariosRoot: SCENARIOS_ROOT,
    webDist: WEB_DIST,
    dbPath,
    scenariosExist: existsSync(join(SCENARIOS_ROOT, DEFAULT_SCENARIO_ID, "meta.json")),
    webDistExists: existsSync(join(WEB_DIST, "index.html")),
  },
  "CrisisGrid server boot paths",
);

let db: Db;
try {
  db = openDb(dbPath);
  app.log.info({ dbPath }, "SQLite opened");
} catch (error) {
  app.log.error({ err: error, dbPath }, "Failed to open SQLite database");
  throw error;
}
void defaultDbPath;

const engine = new ScenarioEngine(db, SCENARIOS_ROOT);
const toolCtx = new ToolContext(dbPath);
const scheduler = startProviderScheduler(db, engine);
const AGENTS_URL = process.env.AGENTS_URL ?? "http://127.0.0.1:8090";

await app.register(cors, { origin: true });

function probeDatabase(): { ok: boolean; detail: string; path: string } {
  try {
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return row?.ok === 1
      ? { ok: true, detail: "SQLite read probe succeeded", path: dbPath }
      : { ok: false, detail: "SQLite probe returned unexpected value", path: dbPath };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      path: dbPath,
    };
  }
}

function probeScenario(scenarioId = DEFAULT_SCENARIO_ID): {
  ok: boolean;
  scenarioId: string;
  tick: number | null;
  detail: string;
  filesPresent: boolean;
} {
  const filesPresent = existsSync(join(SCENARIOS_ROOT, scenarioId, "meta.json"));
  try {
    const tick = engine.currentTick(scenarioId);
    return {
      ok: true,
      scenarioId,
      tick,
      detail: "Scenario loaded in SQLite",
      filesPresent,
    };
  } catch (error) {
    return {
      ok: false,
      scenarioId,
      tick: null,
      detail: error instanceof Error ? error.message : String(error),
      filesPresent,
    };
  }
}

function ensureScenarioLoaded(scenarioId = DEFAULT_SCENARIO_ID): {
  ok: boolean;
  scenarioId: string;
  tick: number | null;
  simTime: string | null;
  detail: string;
} {
  try {
    const tick = engine.currentTick(scenarioId);
    return {
      ok: true,
      scenarioId,
      tick,
      simTime: engine.simTimeAt(scenarioId, tick),
      detail: "already loaded",
    };
  } catch {
    try {
      const loaded = engine.load(scenarioId);
      app.log.info({ scenarioId, ...loaded }, "Seeded scenario into SQLite");
      return {
        ok: true,
        scenarioId,
        tick: loaded.tick,
        simTime: loaded.simTime,
        detail: "loaded from scenario files",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      app.log.error(
        { err: error, scenarioId, scenariosRoot: SCENARIOS_ROOT },
        "Failed to seed scenario",
      );
      return { ok: false, scenarioId, tick: null, simTime: null, detail };
    }
  }
}

const bootSeed = ensureScenarioLoaded(DEFAULT_SCENARIO_ID);

app.get("/api/health", async () => {
  let agentsOnline = false;
  let llmConfigured = false;
  try {
    const res = await fetch(`${AGENTS_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = (await res.json()) as { llmConfigured?: boolean };
      agentsOnline = true;
      llmConfigured = !!data.llmConfigured;
    }
  } catch {
    // offline
  }

  const database = probeDatabase();
  const scenario = probeScenario(DEFAULT_SCENARIO_ID);
  const active =
    (db.prepare("SELECT id FROM scenarios ORDER BY loaded_at DESC LIMIT 1").get() as
      | { id: string }
      | undefined)?.id ?? null;

  return {
    ok: database.ok && scenario.ok,
    status: database.ok && scenario.ok ? "ready" : "degraded",
    service: "crisisgrid-server",
    server: {
      status: "up",
      port: Number(process.env.PORT ?? process.env.SERVER_PORT ?? 18080),
      hostingStatic: existsSync(join(WEB_DIST, "index.html")),
    },
    database,
    scenario,
    activeScenarioId: active,
    seed: bootSeed,
    sseClients: clientCount(),
    auth: authStatus(),
    agents: {
      online: agentsOnline,
      llmConfigured,
    },
    scheduler: scheduler.status().map((job) => ({
      id: job.id,
      enabled: job.enabled,
      lastOkAt: job.lastOkAt,
      lastError: job.lastError,
    })),
  };
});

app.get("/api/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  reply.raw.write(`event: connected\ndata: {"ok":true}\n\n`);
  addClient(reply);
  const ka = setInterval(() => reply.raw.write(": keep-alive\n\n"), 25_000);
  reply.raw.on("close", () => clearInterval(ka));
});

scenarioRoutes(app, engine);
actionRoutes(app, db, toolCtx);
incidentRoutes(app, db, engine);
runtimeRoutes(app, db);
mapRoutes(app, db, engine);
opsRoutes(app, db, scheduler);

app.setErrorHandler((error, req, reply) => {
  req.log.error(
    {
      err: error,
      url: req.url,
      method: req.method,
    },
    "Unhandled route error",
  );
  const statusCode = typeof error === "object" && error && "statusCode" in error
    ? Number((error as { statusCode?: number }).statusCode) || 500
    : 500;
  void reply.code(statusCode).send({
    error: error instanceof Error ? error.message : String(error),
    path: req.url,
  });
});

// Production monolith: same process serves API + built UI (Railway public PORT).
if (existsSync(join(WEB_DIST, "index.html"))) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: "/",
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found", path: req.url });
    }
    return reply.sendFile("index.html");
  });
  app.log.info({ webDist: WEB_DIST }, "Serving built web UI from Fastify");
} else {
  app.log.warn({ webDist: WEB_DIST }, "No web dist found — API-only mode");
}

// Railway / Cloud Run / Fly inject PORT. Prefer it so the public edge hits Fastify directly.
const port = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 18080);
await app.listen({ port, host: "0.0.0.0" });
app.log.info({ port, host: "0.0.0.0" }, "CrisisGrid listening");
broadcast({ type: "server.started", payload: { port } });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down CrisisGrid server");
  scheduler.stop();
  await app.close();
  db.close();
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
