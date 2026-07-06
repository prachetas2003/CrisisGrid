import { z } from "zod";
import type { SafetyTier } from "./schemas/core.js";

/**
 * Deterministic action classification rules (plan/09-safety-security.md §1).
 * This is Layer 4 of defense-in-depth: it runs in code, in both the MCP
 * server (safety.evaluate_action) and the orchestration server (action
 * queue), regardless of what any LLM says. Eval 8 asserts these rules.
 */

export const ProposedAction = z.object({
  kind: z.enum([
    "analysis",
    "recommendation",
    "draft",
    "simulation",
    "public_comms",
    "internal_comms",
    "dispatch",
    "evacuation_guidance",
    "resource_assignment",
    "shelter_assignment",
    "scenario_mutation",
    "broadcast",
  ]),
  title: z.string(),
  description: z.string(),
  simulated: z.boolean().default(true),
  confidence: z.number().min(0).max(1).default(1),
  evidence: z.array(z.string()).default([]),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

export interface PolicyRule {
  id: string;
  reason: string;
  tier: SafetyTier;
  match: (a: ProposedAction) => boolean;
}

const BANNED_CLAIMS = /\b(diagnos\w*|prescri\w*|legal liability|guaranteed safe|no risk)\b/i;

export const POLICY_RULES: PolicyRule[] = [
  {
    id: "R-02",
    reason: "Real dispatch is out of scope by design — simulated dispatch only",
    tier: "blocked",
    match: (a) => a.kind === "dispatch" && !a.simulated,
  },
  {
    id: "R-06",
    reason: "Unsupported broadcast to all channels is blocked — use the sandbox demo feed",
    tier: "blocked",
    match: (a) => a.kind === "broadcast",
  },
  {
    id: "R-03",
    reason: "Evacuation guidance requires confidence >= 0.5 and at least one evidence reference",
    tier: "blocked",
    match: (a) => a.kind === "evacuation_guidance" && (a.confidence < 0.5 || a.evidence.length === 0),
  },
  {
    id: "R-04",
    reason: "Medical/legal claims beyond available data are blocked",
    tier: "blocked",
    match: (a) => BANNED_CLAIMS.test(a.description) || BANNED_CLAIMS.test(a.title),
  },
  {
    id: "R-01",
    reason: "External communication requires operator approval",
    tier: "needs_approval",
    match: (a) => a.kind === "public_comms",
  },
  {
    id: "R-07",
    reason: "Internal team notification requires operator approval",
    tier: "needs_approval",
    match: (a) => a.kind === "internal_comms",
  },
  {
    id: "R-05",
    reason: "Resource commitment requires operator approval",
    tier: "needs_approval",
    match: (a) => a.kind === "resource_assignment" || a.kind === "shelter_assignment",
  },
  {
    id: "R-08",
    reason: "Simulated dispatch requires operator approval",
    tier: "needs_approval",
    match: (a) => a.kind === "dispatch" && a.simulated,
  },
  {
    id: "R-09",
    reason: "Mutating shared scenario state requires operator approval",
    tier: "needs_approval",
    match: (a) => a.kind === "scenario_mutation",
  },
  {
    id: "R-10",
    reason: "Evacuation guidance with adequate confidence/evidence still requires operator approval",
    tier: "needs_approval",
    match: (a) => a.kind === "evacuation_guidance",
  },
  {
    id: "R-99",
    reason: "Analysis, drafting, and simulation actions are safe",
    tier: "safe",
    match: () => true,
  },
];

export interface PolicyDecision {
  tier: SafetyTier;
  matchedRules: { id: string; reason: string }[];
}

/** First matching rule wins; rules are ordered blocked > approval > safe. */
export function evaluateAction(action: ProposedAction): PolicyDecision {
  for (const rule of POLICY_RULES) {
    if (rule.match(action)) {
      return { tier: rule.tier, matchedRules: [{ id: rule.id, reason: rule.reason }] };
    }
  }
  // Unreachable: R-99 matches everything. Kept for exhaustiveness.
  return { tier: "safe", matchedRules: [{ id: "R-99", reason: "default" }] };
}

/** Phrases the comms validator refuses in public drafts (plan/09 §8). */
export const BANNED_COMMS_PHRASES = [
  "mandatory",
  "ordered by",
  "martial law",
  "by order of the governor",
  "guaranteed",
  "no danger",
];

export const SMS_MAX_CHARS = 320;
