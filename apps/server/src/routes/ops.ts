import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyAuditChain, type Db } from "@crisisgrid/engine";
import { clientCount } from "../sse/bus.js";
import { type ProviderScheduler } from "../providers/scheduler.js";
import { runtimeSnapshot } from "./runtime.js";
import { authStatus, requireRole } from "../security/auth.js";

export function opsRoutes(app: FastifyInstance, db: Db, scheduler: ProviderScheduler): void {
  app.get("/api/ops/liveness", async () => ({
    ok: true,
    service: "crisisgrid-server",
    generatedAt: new Date().toISOString(),
  }));

  app.get("/api/ops/health", async () => healthSnapshot(db, scheduler));

  app.get("/api/ops/readiness", async (_req, reply) => {
    const health = healthSnapshot(db, scheduler);
    if (!health.ready) reply.code(503);
    return health;
  });

  app.post("/api/ops/jobs/run", { preHandler: requireRole("operator") }, async (req) => {
    const { jobId } = z.object({ jobId: z.string().optional() }).parse(req.body ?? {});
    return {
      generatedAt: new Date().toISOString(),
      jobs: await scheduler.runNow(jobId),
    };
  });
}

function healthSnapshot(db: Db, scheduler: ProviderScheduler) {
  const runtime = runtimeSnapshot(db);
  const database = databaseHealth(db);
  const audit = auditHealth(db);
  const jobs = scheduler.status();
  const weather = runtime.providers.find((provider) => provider.domain === "weather.forecast");
  const weatherReady =
    runtime.mode === "demo" || weather?.status === "ready" || weather?.status === "fallback";
  const ready = database.ok && audit.ok && weatherReady;
  return {
    ok: database.ok,
    ready,
    service: "crisisgrid-server",
    generatedAt: new Date().toISOString(),
    runtime,
    auth: authStatus(),
    database,
    audit,
    scheduler: {
      enabledJobs: jobs.filter((job) => job.enabled).length,
      failedJobs: jobs.filter((job) => job.lastError).length,
      jobs,
    },
    sseClients: clientCount(),
  };
}

function databaseHealth(db: Db): { ok: boolean; detail: string } {
  try {
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return row?.ok === 1
      ? { ok: true, detail: "SQLite read/write connection is available." }
      : { ok: false, detail: "SQLite health probe returned an unexpected value." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function auditHealth(db: Db): { ok: boolean; detail: string } {
  try {
    const result = verifyAuditChain(db);
    return result.ok
      ? { ok: true, detail: "Audit chain verified." }
      : { ok: false, detail: `Audit chain break at entry ${result.brokenAtId}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
