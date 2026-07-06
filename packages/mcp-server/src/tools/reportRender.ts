import { Finding, IncidentActionPlan, type Finding as FindingT, type IncidentActionPlan as PlanT } from "@crisisgrid/shared";
import type { ToolContext } from "../context.js";

/**
 * Deterministic report bundle + markdown renderer (plan/04 §3.9).
 * Section order is fixed; eval 12 asserts every section is present and every
 * timestamp/approval matches the DB.
 */

export interface ReportBundle {
  incidentId: string;
  scenarioId: string;
  simTime: string;
  tick: number;
  operatorText: string | null;
  incident: unknown;
  findings: FindingT[];
  latestPlan: PlanT | null;
  riskOverlay: { zone: string; score: number; band: string }[];
  cityScore: number | null;
  timeline: { tick: number; eventId: string; announcement: string }[];
  actions: {
    id: string; kind: string; tier: string; status: string; title: string;
    approvedBy: string | null; approvedAt: string | null; blockedReason: string | null;
  }[];
  commsDrafts: { draftId: string; channel: string; audience: string; validated: boolean; body: string }[];
  sandboxPublishes: { draftId: string; channel: string; publishedAt: string }[];
  toolCallStats: { tool: string; calls: number }[];
  auditTail: { id: number; ts: string; actor: string; eventType: string; contentHash: string }[];
  dataHonesty: string;
}

export function buildBundle(ctx: ToolContext, scenarioId: string, incidentId: string): ReportBundle {
  const db = ctx.db;
  const tick = ctx.engine.currentTick(scenarioId);

  const incidentRow = db
    .prepare("SELECT operator_text, parsed_json FROM incidents WHERE id = ?")
    .get(incidentId) as { operator_text: string; parsed_json: string | null } | undefined;

  const findings = (
    db.prepare("SELECT finding_json FROM findings WHERE incident_id = ? ORDER BY created_at, id").all(incidentId) as { finding_json: string }[]
  ).flatMap((r) => {
    const parsed = Finding.safeParse(JSON.parse(r.finding_json));
    return parsed.success ? [parsed.data] : [];
  });

  const planRow = db
    .prepare("SELECT plan_json FROM plans WHERE incident_id = ? ORDER BY revision DESC LIMIT 1")
    .get(incidentId) as { plan_json: string } | undefined;
  const latestPlan = planRow ? IncidentActionPlan.parse(JSON.parse(planRow.plan_json)) : null;

  const overlay = ctx.engine
    .stateAt(scenarioId, tick)
    .filter((e) => e.entityType === "riskOverlay");
  const riskOverlay = overlay
    .filter((e) => e.entityId !== "city")
    .map((e) => ({
      zone: e.entityId,
      score: (e.state as { score0to100: number }).score0to100,
      band: (e.state as { band: string }).band,
    }))
    .sort((a, b) => b.score - a.score);
  const city = overlay.find((e) => e.entityId === "city");

  const actions = (
    db.prepare(
      `SELECT id, kind, tier, status, payload_json, approved_by, approved_at, blocked_reason
       FROM actions WHERE incident_id = ? OR incident_id IS NULL ORDER BY created_at`,
    ).all(incidentId) as {
      id: string; kind: string; tier: string; status: string; payload_json: string;
      approved_by: string | null; approved_at: string | null; blocked_reason: string | null;
    }[]
  ).map((a) => ({
    id: a.id, kind: a.kind, tier: a.tier, status: a.status,
    title: (JSON.parse(a.payload_json) as { title?: string }).title ?? a.kind,
    approvedBy: a.approved_by, approvedAt: a.approved_at, blockedReason: a.blocked_reason,
  }));

  const commsDrafts = (
    db.prepare(
      "SELECT draft_id, channel, audience, validated, body FROM comms_drafts WHERE incident_id = ? OR incident_id IS NULL ORDER BY created_at",
    ).all(incidentId) as { draft_id: string; channel: string; audience: string; validated: number; body: string }[]
  ).map((d) => ({ draftId: d.draft_id, channel: d.channel, audience: d.audience, validated: d.validated === 1, body: d.body }));

  const sandboxPublishes = (
    db.prepare("SELECT draft_id, channel, published_at FROM sandbox_feed ORDER BY id").all() as { draft_id: string; channel: string; published_at: string }[]
  ).map((p) => ({ draftId: p.draft_id, channel: p.channel, publishedAt: p.published_at }));

  const toolCallStats = db
    .prepare("SELECT tool, COUNT(*) AS calls FROM tool_calls GROUP BY tool ORDER BY calls DESC")
    .all() as { tool: string; calls: number }[];

  const auditTail = (
    db.prepare("SELECT id, ts, actor, event_type, content_hash FROM audit_log ORDER BY id DESC LIMIT 20").all() as { id: number; ts: string; actor: string; event_type: string; content_hash: string }[]
  ).map((a) => ({ id: a.id, ts: a.ts, actor: a.actor, eventType: a.event_type, contentHash: a.content_hash })).reverse();

  return {
    incidentId,
    scenarioId,
    simTime: ctx.engine.simTimeAt(scenarioId, tick),
    tick,
    operatorText: incidentRow?.operator_text ?? null,
    incident: incidentRow?.parsed_json ? JSON.parse(incidentRow.parsed_json) : null,
    findings,
    latestPlan,
    riskOverlay,
    cityScore: city ? (city.state as { cityScore: number }).cityScore : null,
    timeline: ctx.engine.firedEvents(scenarioId),
    actions,
    commsDrafts,
    sandboxPublishes,
    toolCallStats,
    auditTail,
    dataHonesty: ctx.engine.dataset(scenarioId).meta.dataHonesty,
  };
}

const SECTION_ORDER = [
  "Incident Summary", "Timeline", "Risk Assessment", "Agent Assessments",
  "Incident Action Plan", "Approvals & Blocked Actions", "Communications",
  "Unresolved Risks", "Assumptions", "Next Steps", "Data Sources & Audit",
] as const;

export function renderIncidentBrief(
  b: ReportBundle,
  narrative: { executiveSummary?: string; outlook?: string },
): string {
  const lines: string[] = [];
  const h = (s: string) => lines.push(`\n## ${s}\n`);

  lines.push(`# Incident Brief — ${b.incidentId}`);
  lines.push(`\n> **SIMULATED EXERCISE** · Scenario: ${b.scenarioId} · Sim time: ${b.simTime} (tick ${b.tick}) · Generated by CrisisGrid`);

  h(SECTION_ORDER[0]);
  if (narrative.executiveSummary) lines.push(narrative.executiveSummary, "");
  if (b.operatorText) lines.push(`**Operator request:** ${b.operatorText}`);
  if (b.latestPlan) lines.push("", b.latestPlan.situationSummary);

  h(SECTION_ORDER[1]);
  for (const e of b.timeline) lines.push(`- \`tick ${String(e.tick).padStart(2)}\` **${e.eventId}** — ${e.announcement}`);

  h(SECTION_ORDER[2]);
  lines.push(`**City risk score:** ${b.cityScore ?? "n/a"} / 100`);
  lines.push("", "| Zone | Score | Band |", "|---|---|---|");
  for (const z of b.riskOverlay.slice(0, 8)) lines.push(`| ${z.zone} | ${z.score} | ${z.band.toUpperCase()} |`);

  h(SECTION_ORDER[3]);
  for (const f of b.findings) {
    lines.push(`### ${f.id} · ${f.agentId} · ${f.severity.toUpperCase()} (confidence ${Math.round(f.confidence * 100)}%)`);
    lines.push(f.finding, "", f.detail, "");
    lines.push(`Evidence: ${f.evidence.map((e) => `${e.kind}:${e.ref}`).join("; ")}`);
    if (f.assumptions.length > 0) lines.push(`Assumptions: ${f.assumptions.join("; ")}`);
    lines.push("");
  }
  if (b.findings.length === 0) lines.push("_No agent findings recorded._");

  h(SECTION_ORDER[4]);
  if (b.latestPlan) {
    const p = b.latestPlan;
    lines.push(`Revision ${p.revision} · Risk ${p.riskScore}/100 · Confidence ${Math.round(p.confidence * 100)}%`, "");
    lines.push("**Objectives**");
    for (const o of p.objectives) lines.push(`- ${o}`);
    lines.push("", "**Immediate (next 15 min)**");
    for (const a of p.timePhases.immediate) lines.push(`- ${a}`);
    lines.push("", "**Short term (next 1 h)**");
    for (const a of p.timePhases.shortTerm) lines.push(`- ${a}`);
    lines.push("", "**Next operational period**");
    for (const a of p.timePhases.nextPeriod) lines.push(`- ${a}`);
    if (p.conflictResolutions.length > 0) {
      lines.push("", "**Conflict resolutions (agent debate outcomes)**");
      for (const c of p.conflictResolutions) lines.push(`- ${c.decision} — ${c.rationale}`);
    }
  } else {
    lines.push("_No plan synthesized yet._");
  }

  h(SECTION_ORDER[5]);
  lines.push("| Action | Kind | Tier | Status | Approved by | Blocked reason |", "|---|---|---|---|---|---|");
  for (const a of b.actions)
    lines.push(`| ${a.title} | ${a.kind} | ${a.tier} | ${a.status} | ${a.approvedBy ?? "—"} | ${a.blockedReason ?? "—"} |`);

  h(SECTION_ORDER[6]);
  for (const d of b.commsDrafts) {
    lines.push(`**${d.channel.toUpperCase()}** (${d.audience}) — ${d.validated ? "validated" : "FAILED VALIDATION"}`);
    lines.push("```", d.body, "```", "");
  }
  for (const pub of b.sandboxPublishes) lines.push(`- Published to SANDBOX feed: ${pub.draftId} (${pub.channel}) at ${pub.publishedAt} — SIMULATED`);
  if (b.commsDrafts.length === 0) lines.push("_No drafts._");

  h(SECTION_ORDER[7]);
  for (const r of b.latestPlan?.unresolvedRisks ?? []) lines.push(`- ${r}`);
  if ((b.latestPlan?.unresolvedRisks ?? []).length === 0) lines.push("_None recorded._");

  h(SECTION_ORDER[8]);
  const assumptions = new Set<string>([...(b.latestPlan?.assumptions ?? []), ...b.findings.flatMap((f) => f.assumptions)]);
  for (const a of assumptions) lines.push(`- ${a}`);
  if (assumptions.size === 0) lines.push("_None recorded._");

  h(SECTION_ORDER[9]);
  if (narrative.outlook) lines.push(narrative.outlook);
  else lines.push("- Re-run assessment after next scenario development or what-if adoption.");

  h(SECTION_ORDER[10]);
  lines.push(b.dataHonesty, "");
  lines.push(`Tool calls this session: ${b.toolCallStats.reduce((a, t) => a + t.calls, 0)} across ${b.toolCallStats.length} tools.`);
  lines.push("", "Audit chain tail (tamper-evident):");
  for (const a of b.auditTail.slice(-8)) lines.push(`- #${a.id} ${a.ts} ${a.actor} ${a.eventType} \`${a.contentHash.slice(0, 12)}…\``);

  return lines.join("\n") + "\n";
}
