import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, type Db, type ScenarioEngine } from "@crisisgrid/engine";
import { broadcast } from "../sse/bus.js";

/**
 * /api/incidents — kicks off an agent assessment run (plan/03 §2).
 * The Python ADK service streams NDJSON pipeline events; THIS process is the
 * single DB writer for agent outputs (findings, plans, incident revisions)
 * and re-broadcasts every event over SSE for the Agent Room UI.
 */

const AGENTS_URL = process.env.AGENTS_URL ?? "http://127.0.0.1:8090";

export function incidentRoutes(app: FastifyInstance, db: Db, engine: ScenarioEngine): void {
  app.get("/api/incidents", async () => {
    const rows = db
      .prepare("SELECT id, scenario_id, operator_text, status, created_at FROM incidents ORDER BY created_at DESC LIMIT 50")
      .all();
    return { incidents: rows };
  });

  app.get("/api/incidents/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const incident = db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!incident) return reply.code(404).send({ error: "unknown incident" });
    const findings = (db.prepare("SELECT finding_json FROM findings WHERE incident_id = ? ORDER BY created_at, id").all(id) as { finding_json: string }[])
      .map((r) => JSON.parse(r.finding_json));
    const plans = (db.prepare("SELECT id, revision, plan_json FROM plans WHERE incident_id = ? ORDER BY revision").all(id) as { id: string; revision: number; plan_json: string }[])
      .map((r) => ({ planId: r.id, revision: r.revision, plan: JSON.parse(r.plan_json) }));
    return { incident: { ...incident, parsed: incident.parsed_json ? JSON.parse(incident.parsed_json as string) : null, parsed_json: undefined }, findings, plans };
  });

  /**
   * POST /api/incidents { operatorText, scenarioId? }
   * Streams the agent pipeline's NDJSON events straight through to the HTTP
   * response while persisting and SSE-broadcasting each one.
   */
  app.post("/api/incidents", async (req, reply) => {
    const parsed = z
      .object({ operatorText: z.string().min(3), scenarioId: z.string().optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Please describe the situation in at least a few words.",
      });
    }
    const { operatorText, scenarioId } = parsed.data;

    const resolvedScenario =
      scenarioId ??
      ((db.prepare("SELECT id FROM scenarios ORDER BY loaded_at DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? "westside-cascade");
    const incidentId = `inc-${randomUUID().slice(0, 8)}`;
    db.prepare(
      "INSERT INTO incidents (id, scenario_id, operator_text, parsed_json, status, created_at) VALUES (?, ?, ?, NULL, 'running', ?)",
    ).run(incidentId, resolvedScenario, operatorText, new Date().toISOString());
    auditLog(db, { actor: "operator", eventType: "incident.created", detail: { incidentId, operatorText } });

    let upstream: Response;
    try {
      upstream = await fetch(`${AGENTS_URL}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorText, scenarioId: resolvedScenario, incidentId }),
      });
      if (!upstream.ok || !upstream.body) throw new Error(`agent service responded ${upstream.status}`);
    } catch (err) {
      db.prepare("UPDATE incidents SET status = 'failed' WHERE id = ?").run(incidentId);
      return reply.code(502).send({
        error: `Agent service unreachable at ${AGENTS_URL}: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Start it with: pnpm agents (requires GOOGLE_API_KEY)",
        incidentId,
      });
    }

    reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });

    const persist = (event: Record<string, unknown>) => {
      const type = event.type as string;
      try {
        if (type === "incident.parsed") {
          db.prepare("UPDATE incidents SET parsed_json = ? WHERE id = ?").run(JSON.stringify(event.incident), incidentId);
        } else if (type === "agent.finding") {
          const f = event.finding;
          const finding = f as { id: string; agentId: string };
          db.prepare(
            "INSERT OR REPLACE INTO findings (id, incident_id, agent_id, finding_json, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run(`${incidentId}:${finding.id}`, incidentId, finding.agentId, JSON.stringify(f), new Date().toISOString());
        } else if (type === "plan.draft" || type === "plan.final") {
          const plan = event.plan as { revision: number; riskScore: number; confidence: number };
          db.prepare(
            "INSERT OR REPLACE INTO plans (id, incident_id, revision, plan_json, risk_score, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            `plan-${incidentId}-r${plan.revision}`, incidentId, plan.revision,
            JSON.stringify(plan), plan.riskScore, plan.confidence, new Date().toISOString(),
          );
        } else if (type === "debate.turn") {
          const t = event.turn as { round: number; fromAgent: string; toAgent: string; stance: string; text: string; evidenceRefs: string[] };
          db.prepare(
            "INSERT INTO debates (incident_id, round, from_agent, to_agent, stance, text, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(incidentId, t.round, t.fromAgent, t.toAgent, t.stance, t.text, JSON.stringify(t.evidenceRefs));
        } else if (type === "run.complete") {
          db.prepare("UPDATE incidents SET status = 'complete' WHERE id = ?").run(incidentId);
          auditLog(db, { actor: "agents", eventType: "run.complete", detail: event });
        } else if (type === "run.error") {
          db.prepare("UPDATE incidents SET status = 'failed' WHERE id = ?").run(incidentId);
          auditLog(db, { actor: "agents", eventType: "run.error", detail: event });
        }
      } catch (err) {
        app.log.error({ err, type }, "failed to persist pipeline event");
      }
      broadcast({ type: `pipeline.${type}`, payload: { incidentId, ...event } });
    };

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          persist(JSON.parse(line) as Record<string, unknown>);
        } catch {
          app.log.warn({ line: line.slice(0, 200) }, "unparseable pipeline event");
        }
        reply.raw.write(line + "\n");
      }
    }
    // Safety net: if the stream ended without a terminal event, don't leave 'running'.
    const status = (db.prepare("SELECT status FROM incidents WHERE id = ?").get(incidentId) as { status: string }).status;
    if (status === "running") db.prepare("UPDATE incidents SET status = 'failed' WHERE id = ?").run(incidentId);
    void engine; // engine reserved for M4 (fork adoption on run completion)
    reply.raw.end();
  });
}
