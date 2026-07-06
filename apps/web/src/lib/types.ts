/** Domain types mirrored from the backend (packages/shared zod schemas). */

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type AgentId =
  | "intake"
  | "weather"
  | "power"
  | "traffic"
  | "shelter"
  | "commander"
  | "safety"
  | "comms"
  | "briefing";

export interface Evidence {
  kind: "tool_call" | "dataset" | "assumption" | "agent_finding";
  ref: string;
  summary: string;
}

export interface Finding {
  id: string;
  agentId: AgentId;
  finding: string;
  detail: string;
  severity: Severity;
  confidence: number;
  evidence: Evidence[];
  recommendedAction: {
    title: string;
    description: string;
    tier: string;
    timeWindow: string;
    targetTeam: string;
  } | null;
  assumptions: string[];
  affectedZones: string[];
  expiresAt: string | null;
}

export interface PlannedAction {
  id: string;
  title: string;
  description: string;
  tier: "safe" | "needs_approval" | "blocked";
  timeWindow: "immediate" | "short_term" | "next_period";
  targetTeam: string;
  dependsOn: string[];
  sourceFindings: string[];
  simulated: boolean;
}

export interface Plan {
  incidentId: string;
  revision: number;
  situationSummary: string;
  riskScore: number;
  objectives: string[];
  actions: PlannedAction[];
  timePhases: { immediate: string[]; shortTerm: string[]; nextPeriod: string[] };
  conflictResolutions: { conflictId: string; decision: string; rationale: string; evidenceRefs: string[] }[];
  commsPlan: string[];
  unresolvedRisks: string[];
  assumptions: string[];
  confidence: number;
}

export interface Conflict {
  conflictId: string;
  kind: string;
  subject: string;
  agents: AgentId[];
  findings: string[];
  summary: string;
}

export interface DebateTurn {
  conflictId: string;
  round: number;
  fromAgent: AgentId;
  toAgent: AgentId;
  stance: "confirm" | "contest" | "amend";
  text: string;
  evidenceRefs: string[];
}

export interface SafetyReview {
  verdict: "approved" | "revise";
  revisions: { issue: string; requiredChange: string }[];
  notes: string;
}

/** NDJSON pipeline events streamed from POST /api/incidents. */
export type PipelineEvent =
  | { type: "run.start"; incidentId: string; scenarioId: string }
  | { type: "phase"; phase: string }
  | { type: "incident.parsed"; incident: Record<string, unknown> }
  | { type: "agent.status"; agentId: AgentId; state: "working" | "done" }
  | { type: "agent.tool_call"; agentId: string; tool: string; args?: Record<string, unknown> }
  | { type: "agent.tool_result"; agentId: string; tool: string; toolCallId: string | null }
  | { type: "agent.finding"; finding: Finding; amended?: boolean }
  | { type: "agent.retry"; agentId: string; error: string }
  | { type: "agent.error"; agentId: string; error: string }
  | { type: "conflict.detected"; conflict: Conflict }
  | { type: "debate.turn"; turn: DebateTurn }
  | { type: "plan.draft"; plan: Plan; revision: number }
  | { type: "safety.review"; review: SafetyReview; loop: number }
  | { type: "safety.loop_exhausted"; outstanding: unknown[] }
  | { type: "plan.final"; plan: Plan }
  | { type: "comms.drafts"; raw: string }
  | { type: "briefing.sections"; sections: { executiveSummary?: string; outlook?: string } }
  | {
      type: "run.complete";
      incidentId: string;
      findings: number;
      conflicts: number;
      debateTurns: number;
      planRevision: number;
      riskScore: number;
    }
  | { type: "run.error"; incidentId?: string; error: string };

// ---------------------------------------------------------------------------
// Map snapshot (GET /api/map/snapshot)
// ---------------------------------------------------------------------------

export interface ZoneProps {
  kind: "zone";
  zoneId: string;
  name: string;
  population: number;
  households: number;
  density: string;
  vulnerabilityIndex: { elderlyPct: number; medDevicePct: number; nonEnglishPct: number; mobilityPct: number };
}

export interface GeoFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

export interface MapSnapshot {
  runtime: { mode: "demo" | "live"; scenarioId: string };
  scenario: { id: string; name: string; city: string; description: string; dataHonesty: string };
  tick: number;
  currentTick: number;
  simTime: string;
  geometry: {
    city: { type: "FeatureCollection"; features: GeoFeature[] };
    facilities: { facilities: Facility[] };
    network: { corridors: Corridor[]; routes: RouteDef[] };
  };
  state: { byType: Record<string, EntityState[]> };
  events: { tick: number; eventId: string; announcement: string }[];
  whatifs: { whatifs: WhatIf[] };
}

export interface Facility {
  id: string;
  kind: "hospital" | "shelter" | "school" | "substation" | "signal" | "water" | "staging";
  name: string;
  zone: string;
  lat: number;
  lon: number;
  beds?: number;
  capacity?: number;
  backupGen?: { fuelHours: number };
  accessible?: boolean;
  petFriendly?: boolean;
  feeds?: string[];
}

export interface Corridor {
  id: string;
  name: string;
  zones: string[];
  geo: { type: "LineString"; coordinates: [number, number][] };
  baseCapacityVph: number;
}

export interface RouteDef {
  id: string;
  name: string;
  fromZone: string;
  toZone: string;
  corridorIds: string[];
  bridgeIds: string[];
  floodplainIds: string[];
  baseEtaMin: number;
  distanceKm: number;
}

export type EntityState = { entityId: string; source?: unknown } & Record<string, unknown>;

export interface WhatIf {
  id: string;
  title: string;
  description: string;
  affectedAgents: string[];
}

export interface ActionItem {
  id: string;
  kind: string;
  tier: "safe" | "needs_approval" | "blocked";
  status: "queued" | "approved" | "rejected" | "executed" | "blocked";
  payload: { title?: string; tool?: string; args?: Record<string, unknown>; preview?: unknown };
  matchedRules: { id: string; reason: string }[];
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  blocked_reason: string | null;
  created_at: string;
}

export interface CommsDraft {
  draftId: string;
  incidentId: string | null;
  channel: "sms" | "social" | "email" | "internal";
  audience: string;
  urgency: string;
  body: string;
  validated: boolean;
  issues: string[];
  createdAt: string;
}
