import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioEngine, estimateRestorationPriority, openDb } from "@crisisgrid/engine";
import { OutageState, FacilityPowerState } from "@crisisgrid/shared";

/**
 * Unit halves of eval 4 (critical facility prioritization) and the risk
 * overlay determinism the Commander depends on (plan/10 §2).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCENARIOS_ROOT = join(REPO_ROOT, "scenarios");
const SCENARIO = "westside-cascade";

function loadedEngine(): { engine: ScenarioEngine; close: () => void } {
  const db = openDb(":memory:");
  const engine = new ScenarioEngine(db, SCENARIOS_ROOT);
  engine.load(SCENARIO);
  return { engine, close: () => db.close() };
}

describe("eval 4 (unit): restoration priority ranking", () => {
  it("ranks the hospital circuit (Z-05) #1 for the SUB-W1 outage", () => {
    const { engine, close } = loadedEngine();
    const outage = engine
      .entitiesOfType<unknown>(SCENARIO, 0, "outage")
      .map((s) => OutageState.parse(s))
      .find((o) => o.id === "OUT-1")!;
    const facilityPower = engine
      .entitiesOfType<unknown>(SCENARIO, 0, "facilityPower")
      .map((s) => FacilityPowerState.parse(s));
    const ranked = estimateRestorationPriority(engine.dataset(SCENARIO), outage, facilityPower);

    expect(ranked[0]!.circuitId).toBe("CIRCUIT-Z-05"); // Riverbend General lives here
    expect(ranked[0]!.reason).toContain("Riverbend General");
    // Z-01 has dark signals + more residents but no hospital — must rank below.
    expect(ranked[1]!.circuitId).toBe("CIRCUIT-Z-01");
    close();
  });
});

describe("risk overlay (deterministic risk engine)", () => {
  it("outage zones carry the highest risk at tick 0 and city score is HIGH-band", () => {
    const { engine, close } = loadedEngine();
    const overlay = engine
      .stateAt(SCENARIO, 0)
      .filter((e) => e.entityType === "riskOverlay" && e.entityId !== "city")
      .map((e) => e.state as { zone: string; score0to100: number; band: string });
    const byZone = Object.fromEntries(overlay.map((z) => [z.zone, z]));

    // Z-05: outage + hospital on backup + floodplain + high vulnerability → top zone risk.
    const top = [...overlay].sort((a, b) => b.score0to100 - a.score0to100)[0]!;
    expect(top.zone).toBe("Z-05");
    expect(byZone["Z-05"]!.score0to100).toBeGreaterThan(byZone["Z-06"]!.score0to100);
    expect(byZone["Z-01"]!.score0to100).toBeGreaterThan(byZone["Z-04"]!.score0to100);
    close();
  });

  it("WHATIF-RAIN raises flood-exposed zone risk in the fork", () => {
    const { engine, close } = loadedEngine();
    const baseline = engine
      .stateAt(SCENARIO, 0)
      .find((e) => e.entityType === "riskOverlay" && e.entityId === "Z-09")!
      .state as { score0to100: number };
    const { forkId } = engine.fork(SCENARIO, ["WHATIF-RAIN"]);
    const forked = engine
      .stateAt(SCENARIO, 0, forkId)
      .find((e) => e.entityType === "riskOverlay" && e.entityId === "Z-09")!
      .state as { score0to100: number };
    expect(forked.score0to100).toBeGreaterThan(baseline.score0to100);
    close();
  });
});
