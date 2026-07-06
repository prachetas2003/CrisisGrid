import { describe, expect, it } from "vitest";
import {
  BANNED_COMMS_PHRASES,
  POLICY_RULES,
  ProposedAction,
  evaluateAction,
} from "@crisisgrid/shared";

/**
 * Eval 8 (deterministic layer) — policy rule table (plan/10 §Eval 8, plan/09 §1).
 * These rules run in code in every tool execution path; if they
 * misclassify, no prompt can save us. The LLM-facing injection eval runs
 * in the live pipeline (requires GOOGLE_API_KEY).
 */

const base = {
  title: "t",
  description: "d",
  simulated: true,
  confidence: 1,
  evidence: ["tc-1"],
};

describe("eval 8 — policy rule classification", () => {
  it("blocks real (non-simulated) dispatch — R-02", () => {
    const d = evaluateAction(ProposedAction.parse({ ...base, kind: "dispatch", simulated: false }));
    expect(d.tier).toBe("blocked");
    expect(d.matchedRules[0]!.id).toBe("R-02");
  });

  it("requires approval for simulated dispatch — R-08", () => {
    const d = evaluateAction(ProposedAction.parse({ ...base, kind: "dispatch", simulated: true }));
    expect(d.tier).toBe("needs_approval");
  });

  it("blocks broadcast unconditionally — R-06", () => {
    const d = evaluateAction(ProposedAction.parse({ ...base, kind: "broadcast" }));
    expect(d.tier).toBe("blocked");
    expect(d.matchedRules[0]!.id).toBe("R-06");
  });

  it("blocks evacuation guidance with low confidence or no evidence — R-03", () => {
    const lowConf = evaluateAction(
      ProposedAction.parse({ ...base, kind: "evacuation_guidance", confidence: 0.3 }),
    );
    expect(lowConf.tier).toBe("blocked");
    const noEvidence = evaluateAction(
      ProposedAction.parse({ ...base, kind: "evacuation_guidance", evidence: [] }),
    );
    expect(noEvidence.tier).toBe("blocked");
    const good = evaluateAction(
      ProposedAction.parse({ ...base, kind: "evacuation_guidance", confidence: 0.8 }),
    );
    expect(good.tier).toBe("needs_approval"); // still gated by R-10, never auto-safe
  });

  it("blocks medical/legal claims — R-04", () => {
    const d = evaluateAction(
      ProposedAction.parse({
        ...base,
        kind: "analysis",
        description: "We can diagnose residents with hypothermia risk remotely",
      }),
    );
    expect(d.tier).toBe("blocked");
    expect(d.matchedRules[0]!.id).toBe("R-04");
  });

  it("gates all external-effect kinds behind approval", () => {
    for (const kind of ["public_comms", "internal_comms", "resource_assignment", "shelter_assignment", "scenario_mutation"] as const) {
      expect(evaluateAction(ProposedAction.parse({ ...base, kind })).tier).toBe("needs_approval");
    }
  });

  it("classifies analysis/draft/simulation as safe", () => {
    for (const kind of ["analysis", "recommendation", "draft", "simulation"] as const) {
      expect(evaluateAction(ProposedAction.parse({ ...base, kind })).tier).toBe("safe");
    }
  });

  it("rule table is ordered blocked -> needs_approval -> safe (first match wins soundly)", () => {
    const tiers = POLICY_RULES.map((r) => r.tier);
    const firstApproval = tiers.indexOf("needs_approval");
    const firstSafe = tiers.indexOf("safe");
    expect(tiers.lastIndexOf("blocked")).toBeLessThan(firstApproval);
    expect(tiers.lastIndexOf("needs_approval")).toBeLessThan(firstSafe);
  });

  it("banned comms phrase list covers false-authority language", () => {
    expect(BANNED_COMMS_PHRASES).toContain("mandatory");
    expect(BANNED_COMMS_PHRASES).toContain("ordered by");
  });
});
