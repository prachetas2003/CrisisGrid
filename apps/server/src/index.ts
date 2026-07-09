import "./env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioEngine, defaultDbPath, openDb } from "@crisisgrid/engine";
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
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCENARIOS_ROOT = join(REPO_ROOT, "scenarios");

// Relative DATABASE_PATH always resolves against the repo root — never the
// process cwd — so the server, MCP server, and CLI share one database.
const envDbPath = process.env.DATABASE_PATH;
const dbPath = envDbPath
  ? isAbsolute(envDbPath)
    ? envDbPath
    : join(REPO_ROOT, envDbPath)
  : join(REPO_ROOT, "data", "crisisgrid.sqlite");
const db = openDb(dbPath);
void defaultDbPath; // path resolution is explicit above; helper used by CLI/MCP
const engine = new ScenarioEngine(db, SCENARIOS_ROOT);
// Tool execution context for operator-approved actions — same tier-enforced
// choke point the agents' MCP calls go through (plan/09 §2).
const toolCtx = new ToolContext(dbPath);
const scheduler = startProviderScheduler(db, engine);
const AGENTS_URL = process.env.AGENTS_URL ?? "http://127.0.0.1:8090";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

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

  return {
    ok: true,
    service: "crisisgrid-server",
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
  // Keep-alive comment every 25s so proxies don't drop the stream.
  const ka = setInterval(() => reply.raw.write(": keep-alive\n\n"), 25_000);
  reply.raw.on("close", () => clearInterval(ka));
});

scenarioRoutes(app, engine);
actionRoutes(app, db, toolCtx);
incidentRoutes(app, db, engine);
runtimeRoutes(app, db);
mapRoutes(app, db, engine);
opsRoutes(app, db, scheduler);

const port = Number(process.env.SERVER_PORT ?? 18080);
await app.listen({ port, host: "0.0.0.0" });
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
