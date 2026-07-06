import { z } from "zod";

/**
 * Core cross-runtime schemas (plan/04-agents.md).
 * These are the contracts between agents, tools, server, and UI.
 * JSON Schema exports (for Pydantic generation in apps/agents) are produced
 * by scripts/gen-json-schema.ts into packages/shared/schema/.
 */

export const AgentId = z.enum([
  "intake",
  "weather",
  "power",
  "traffic",
  "shelter",
  "comms",
  "safety",
  "commander",
  "briefing",
]);
export type AgentId = z.infer<typeof AgentId>;

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const SafetyTier = z.enum(["safe", "needs_approval", "blocked"]);
export type SafetyTier = z.infer<typeof SafetyTier>;

export const TimeWindow = z.enum(["immediate", "short_term", "next_period"]);
export type TimeWindow = z.infer<typeof TimeWindow>;

export const ZoneId = z.string().regex(/^Z-\d{2}$/, "Zone ids look like Z-05");
export type ZoneId = z.infer<typeof ZoneId>;

export const Evidence = z.object({
  kind: z.enum(["tool_call", "dataset", "assumption", "agent_finding"]),
  ref: z.string(),
  summary: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const RecommendedAction = z.object({
  title: z.string(),
  description: z.string(),
  tier: SafetyTier,
  timeWindow: TimeWindow,
  targetTeam: z.string(),
});
export type RecommendedAction = z.infer<typeof RecommendedAction>;

/** THE core schema: every domain-agent output is a Finding. */
export const Finding = z.object({
  id: z.string(),
  agentId: AgentId,
  finding: z.string(),
  detail: z.string(),
  severity: Severity,
  confidence: z.number().min(0).max(1),
  evidence: z.array(Evidence).min(1),
  recommendedAction: RecommendedAction.nullable(),
  assumptions: z.array(z.string()),
  affectedZones: z.array(ZoneId),
  /** Sim-time ISO string after which this finding is stale (e.g. route flood window). */
  expiresAt: z.string().nullable(),
  /** True when a what-if run reused this finding instead of re-running the agent. */
  carriedForward: z.boolean().default(false),
});
export type Finding = z.infer<typeof Finding>;

export const Incident = z.object({
  id: z.string(),
  scenarioId: z.string(),
  revision: z.number().int().min(0),
  operatorText: z.string(),
  types: z.array(
    z.enum([
      "power_outage",
      "storm",
      "flood",
      "wildfire",
      "heatwave",
      "traffic_failure",
      "infrastructure",
      "other",
    ]),
  ),
  zones: z.array(ZoneId),
  simTime: z.string(),
  severityHint: Severity,
  constraints: z.array(z.string()),
  operatorIntent: z.string(),
  clarificationNeeded: z.string().nullable(),
  assumptions: z.array(z.string()),
});
export type Incident = z.infer<typeof Incident>;

export const PlannedAction = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tier: SafetyTier,
  timeWindow: TimeWindow,
  targetTeam: z.string(),
  dependsOn: z.array(z.string()),
  sourceFindings: z.array(z.string()),
  simulated: z.boolean().default(true),
});
export type PlannedAction = z.infer<typeof PlannedAction>;

export const ConflictResolution = z.object({
  conflictId: z.string(),
  decision: z.string(),
  rationale: z.string(),
  evidenceRefs: z.array(z.string()),
});
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const IncidentActionPlan = z.object({
  incidentId: z.string(),
  revision: z.number().int().min(0),
  situationSummary: z.string(),
  /** Computed by geo.overlay_risk_layers — narrated, never invented, by the Commander. */
  riskScore: z.number().min(0).max(100),
  objectives: z.array(z.string()),
  actions: z.array(PlannedAction),
  timePhases: z.object({
    immediate: z.array(z.string()),
    shortTerm: z.array(z.string()),
    nextPeriod: z.array(z.string()),
  }),
  conflictResolutions: z.array(ConflictResolution),
  commsPlan: z.array(z.string()),
  unresolvedRisks: z.array(z.string()),
  assumptions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type IncidentActionPlan = z.infer<typeof IncidentActionPlan>;

export const PlanDiff = z.object({
  planA: z.string(),
  planB: z.string(),
  riskDelta: z.object({
    from: z.number(),
    to: z.number(),
    perZone: z.array(z.object({ zone: ZoneId, from: z.number(), to: z.number() })),
  }),
  routeChanges: z.array(
    z.object({ purpose: z.string(), from: z.string(), to: z.string(), reason: z.string() }),
  ),
  shelterChanges: z.array(
    z.object({
      zone: ZoneId,
      fromShelter: z.string(),
      toShelter: z.string(),
      reason: z.string(),
    }),
  ),
  addedActions: z.array(PlannedAction),
  removedActions: z.array(z.object({ action: PlannedAction, reason: z.string() })),
  modifiedActions: z.array(z.object({ before: PlannedAction, after: PlannedAction })),
  changeExplanations: z.array(
    z.object({ change: z.string(), causedBy: z.string(), agentFinding: z.string() }),
  ),
});
export type PlanDiff = z.infer<typeof PlanDiff>;

export const DebateTurn = z.object({
  conflictId: z.string(),
  round: z.number().int().min(1),
  fromAgent: AgentId,
  toAgent: AgentId,
  stance: z.enum(["confirm", "contest", "amend"]),
  text: z.string(),
  evidenceRefs: z.array(z.string()),
  amendedFinding: Finding.nullable(),
});
export type DebateTurn = z.infer<typeof DebateTurn>;

export const CommsDraft = z.object({
  draftId: z.string(),
  channel: z.enum(["sms", "social", "email", "internal"]),
  audience: z.string(),
  urgency: z.enum(["advisory", "watch", "warning"]),
  body: z.string(),
  factsUsed: z.array(z.string()),
  approvalRequired: z.literal(true),
  simulatedWatermark: z.boolean(),
});
export type CommsDraft = z.infer<typeof CommsDraft>;
