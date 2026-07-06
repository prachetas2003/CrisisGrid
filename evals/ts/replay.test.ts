import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioEngine, openDb } from "@crisisgrid/engine";

/**
 * Eval 14 — Scenario replay consistency (plan/10-evaluation-plan.md).
 * Two replays of the same scenario must produce byte-identical state at
 * every tick, and the engine source must contain no unseeded randomness.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCENARIOS_ROOT = join(REPO_ROOT, "scenarios");
const SCENARIO = "westside-cascade";

function replayInMemory(toTick: number): string {
  const db = openDb(":memory:");
  const engine = new ScenarioEngine(db, SCENARIOS_ROOT, () => "1970-01-01T00:00:00.000Z");
  const serialized = engine.replay(SCENARIO, toTick);
  db.close();
  return serialized;
}

describe("eval 14: scenario replay consistency", () => {
  it("two replays to tick 8 are byte-identical at every tick", () => {
    const a = replayInMemory(8);
    const b = replayInMemory(8);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1000); // sanity: real state, not empty
  });

  it("replay fires the exact scripted timeline through tick 8", () => {
    const db = openDb(":memory:");
    const engine = new ScenarioEngine(db, SCENARIOS_ROOT);
    engine.load(SCENARIO);
    engine.tick(SCENARIO, 8);
    const fired = engine.firedEvents(SCENARIO).map((e) => e.eventId);
    expect(fired).toEqual(["EVT-001", "EVT-002", "EVT-003", "EVT-004", "EVT-005"]);
    db.close();
  });

  it("what-if forks never mutate the live timeline", () => {
    const db = openDb(":memory:");
    const engine = new ScenarioEngine(db, SCENARIOS_ROOT);
    engine.load(SCENARIO);
    engine.tick(SCENARIO, 4);
    const before = JSON.stringify(engine.stateAt(SCENARIO, 4));
    const { forkId } = engine.fork(SCENARIO, ["WHATIF-BRIDGE", "WHATIF-RAIN"]);
    const after = JSON.stringify(engine.stateAt(SCENARIO, 4));
    expect(after).toBe(before);
    // ...but the fork does contain the closure.
    const forkState = engine.stateAt(SCENARIO, 4, forkId);
    const closure = forkState.find((e) => e.entityType === "closure" && e.entityId === "CLS-MAIN");
    expect(closure).toBeDefined();
    db.close();
  });

  it("hospital backup fuel drains deterministically with sim time", () => {
    const db = openDb(":memory:");
    const engine = new ScenarioEngine(db, SCENARIOS_ROOT);
    engine.load(SCENARIO);
    engine.tick(SCENARIO, 8); // EVT-005 at tick 8 resets estimate to 6h
    const state = engine.stateAt(SCENARIO, 8);
    const hosp = state.find(
      (e) => e.entityType === "facilityPower" && e.entityId === "HOSP-RG",
    );
    expect(hosp).toBeDefined();
    expect((hosp!.state as { powerStatus: string }).powerStatus).toBe("backup");
    expect((hosp!.state as { backupRemainingH: number }).backupRemainingH).toBe(6);
    db.close();
  });

  it("engine source contains no unseeded randomness or wall-clock in state math", () => {
    const engineSrc = join(REPO_ROOT, "packages", "engine", "src");
    for (const file of readdirSync(engineSrc)) {
      const content = readFileSync(join(engineSrc, file), "utf-8");
      // Match calls, not prose in comments.
      expect(content, `${file} must not call Math.random`).not.toMatch(/Math\.random\s*\(/);
      expect(content, `${file} must not call Date.now`).not.toMatch(/Date\.now\s*\(/);
    }
  });
});
