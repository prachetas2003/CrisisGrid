import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ScenarioEngine } from "@crisisgrid/engine";
import { broadcast } from "../sse/bus.js";
import { requireRole } from "../security/auth.js";

/**
 * Scenario engine HTTP surface (plan/07-scenario-engine.md §2).
 * Also the backend for the MCP sim.* tools, which call these endpoints
 * rather than mutating the DB directly (plan/05 — "source: scenario engine,
 * via server API").
 */

export function scenarioRoutes(app: FastifyInstance, engine: ScenarioEngine): void {
  app.post("/api/scenario/load", { preHandler: requireRole("operator") }, async (req) => {
    const { scenarioId } = z.object({ scenarioId: z.string() }).parse(req.body);
    const result = engine.load(scenarioId);
    const meta = engine.dataset(scenarioId).meta;
    broadcast({ type: "scenario.loaded", payload: { scenarioId, ...result, meta } });
    return { scenarioId, ...result, summary: meta.description };
  });

  app.post("/api/scenario/tick", { preHandler: requireRole("operator") }, async (req) => {
    const { scenarioId, ticks } = z
      .object({ scenarioId: z.string(), ticks: z.number().int().min(1).max(64).default(1) })
      .parse(req.body);
    const results = engine.tick(scenarioId, ticks);
    for (const r of results) {
      broadcast({ type: "scenario.tick", payload: { scenarioId, tick: r.tick, simTime: r.simTime } });
      for (const evt of r.firedEvents) {
        broadcast({
          type: "scenario.event",
          payload: { scenarioId, tick: r.tick, eventId: evt.id, eventType: evt.type, announcement: evt.announcement },
        });
      }
    }
    const last = results[results.length - 1];
    return {
      scenarioId,
      tick: last?.tick ?? engine.currentTick(scenarioId),
      simTime: last?.simTime ?? engine.simTimeAt(scenarioId, engine.currentTick(scenarioId)),
      firedEvents: results.flatMap((r) => r.firedEvents.map((e) => e.id)),
    };
  });

  app.get("/api/scenario/:scenarioId/state", async (req) => {
    const { scenarioId } = z.object({ scenarioId: z.string() }).parse(req.params);
    const query = z
      .object({ tick: z.coerce.number().int().min(0).optional(), forkId: z.string().optional() })
      .parse(req.query);
    const tick = query.tick ?? engine.currentTick(scenarioId);
    return {
      scenarioId,
      tick,
      simTime: engine.simTimeAt(scenarioId, tick),
      forkId: query.forkId ?? "",
      entities: engine.stateAt(scenarioId, tick, query.forkId ?? ""),
    };
  });

  app.get("/api/scenario/:scenarioId/events", async (req) => {
    const { scenarioId } = z.object({ scenarioId: z.string() }).parse(req.params);
    return { scenarioId, events: engine.firedEvents(scenarioId) };
  });

  app.get("/api/scenario/:scenarioId/whatifs", async (req) => {
    const { scenarioId } = z.object({ scenarioId: z.string() }).parse(req.params);
    return { scenarioId, whatifs: engine.listWhatIfs(scenarioId) };
  });

  /** Isolated fork for what-if analysis — never mutates the live timeline. */
  app.post("/api/scenario/fork", { preHandler: requireRole("operator") }, async (req) => {
    const { scenarioId, eventIds } = z
      .object({ scenarioId: z.string(), eventIds: z.array(z.string()).min(1) })
      .parse(req.body);
    const result = engine.fork(scenarioId, eventIds);
    return { scenarioId, ...result };
  });

  /**
   * Apply a what-if to live state ("adopt"). Tier: needs_approval — the full
   * approval-token gate arrives with the action queue in M2/M3; until then
   * this endpoint requires an explicit confirm flag and is audit-logged.
   */
  app.post("/api/scenario/inject", { preHandler: requireRole("operator") }, async (req) => {
    const { scenarioId, eventId, confirm } = z
      .object({ scenarioId: z.string(), eventId: z.string(), confirm: z.literal(true) })
      .parse(req.body);
    void confirm;
    const result = engine.inject(scenarioId, eventId);
    broadcast({ type: "scenario.event", payload: { scenarioId, eventId, eventType: "whatif.injected" } });
    return { scenarioId, eventId, ...result };
  });
}
