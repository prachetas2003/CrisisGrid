import {
  CorridorState,
  FacilityPowerState,
  OutageState,
  WeatherState,
  type StatePatch,
  type TimelineEvent,
  type WhatIfEvent,
} from "@crisisgrid/shared";
import type { Db } from "./db.js";
import { loadScenarioDataset, type ScenarioDataset } from "./loader.js";
import { computeRiskOverlay } from "./risk.js";

/**
 * Deterministic scenario engine (plan/07-scenario-engine.md).
 *
 * World state = bag of entities keyed by (scenarioId, forkId, tick, type, id).
 * State at tick N = state at N-1 + timeline patches for N + derived layers.
 * Past ticks are immutable — rewind is just a read at an earlier tick.
 *
 * Determinism rules: no Math.random, no wall-clock in any state value.
 * Metadata timestamps use an injected clock (irrelevant to state bytes).
 */

const LIVE_FORK = "";

export interface TickResult {
  tick: number;
  simTime: string;
  firedEvents: TimelineEvent[];
}

export interface EntityRow {
  entityType: string;
  entityId: string;
  state: Record<string, unknown>;
}

export class ScenarioEngine {
  private datasets = new Map<string, ScenarioDataset>();

  constructor(
    private db: Db,
    private scenariosRoot: string,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  dataset(scenarioId: string): ScenarioDataset {
    let d = this.datasets.get(scenarioId);
    if (!d) {
      d = loadScenarioDataset(`${this.scenariosRoot}/${scenarioId}`);
      this.datasets.set(scenarioId, d);
    }
    return d;
  }

  /** Wipe state for the scenario and seed tick 0 from initial-state.json. */
  load(scenarioId: string): { tick: number; simTime: string } {
    const d = this.dataset(scenarioId);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM scenario_state WHERE scenario_id = ?").run(scenarioId);
      this.db.prepare("DELETE FROM scenario_events WHERE scenario_id = ?").run(scenarioId);
      this.db.prepare("DELETE FROM forks WHERE scenario_id = ?").run(scenarioId);
      this.db.prepare("DELETE FROM scenarios WHERE id = ?").run(scenarioId);
      this.db
        .prepare(
          `INSERT INTO scenarios (id, name, meta_json, current_tick, start_sim_time, minutes_per_tick, loaded_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          scenarioId,
          d.meta.name,
          JSON.stringify(d.meta),
          d.initialState.startSimTime,
          d.initialState.minutesPerTick,
          this.now(),
        );
      for (const e of d.initialState.entities) {
        this.writeEntity(scenarioId, LIVE_FORK, 0, e.entityType, e.entityId, e.state);
      }
      // Tick-0 timeline events (EVT-001 scenario start) fire immediately.
      const tick0Events = d.timeline.events.filter((e) => e.tick === 0);
      for (const evt of tick0Events) this.applyEvent(scenarioId, LIVE_FORK, 0, evt);
      this.writeDerivedLayers(scenarioId, LIVE_FORK, 0);
    });
    tx();
    return { tick: 0, simTime: this.simTimeAt(scenarioId, 0) };
  }

  currentTick(scenarioId: string): number {
    const row = this.db
      .prepare("SELECT current_tick FROM scenarios WHERE id = ?")
      .get(scenarioId) as { current_tick: number } | undefined;
    if (!row) throw new Error(`Scenario ${scenarioId} not loaded`);
    return row.current_tick;
  }

  simTimeAt(scenarioId: string, tick: number): string {
    const row = this.db
      .prepare("SELECT start_sim_time, minutes_per_tick FROM scenarios WHERE id = ?")
      .get(scenarioId) as { start_sim_time: string; minutes_per_tick: number } | undefined;
    if (!row) throw new Error(`Scenario ${scenarioId} not loaded`);
    const start = new Date(row.start_sim_time);
    const t = new Date(start.getTime() + tick * row.minutes_per_tick * 60_000);
    // Render without timezone conversion — sim time is local wall-clock fiction.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
  }

  /** Advance N ticks, applying timeline patches + derived layers per tick. */
  tick(scenarioId: string, n = 1): TickResult[] {
    const d = this.dataset(scenarioId);
    const results: TickResult[] = [];
    const tx = this.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const from = this.currentTick(scenarioId);
        const to = from + 1;
        this.copyTick(scenarioId, LIVE_FORK, from, to);
        // Drift first (time passing into the tick), then scripted events —
        // an event that sets a fresh value (e.g. revised fuel estimate) wins.
        this.applyDrift(scenarioId, LIVE_FORK, to);
        const fired = d.timeline.events.filter((e) => e.tick === to);
        for (const evt of fired) this.applyEvent(scenarioId, LIVE_FORK, to, evt);
        this.writeDerivedLayers(scenarioId, LIVE_FORK, to);
        this.db
          .prepare("UPDATE scenarios SET current_tick = ? WHERE id = ?")
          .run(to, scenarioId);
        results.push({ tick: to, simTime: this.simTimeAt(scenarioId, to), firedEvents: fired });
      }
    });
    tx();
    return results;
  }

  /** Read all entity state at a tick (optionally in a fork). */
  stateAt(scenarioId: string, tick: number, forkId: string = LIVE_FORK): EntityRow[] {
    const rows = this.db
      .prepare(
        `SELECT entity_type, entity_id, state_json FROM scenario_state
         WHERE scenario_id = ? AND fork_id = ? AND tick = ?
         ORDER BY entity_type, entity_id`,
      )
      .all(scenarioId, forkId, tick) as {
      entity_type: string;
      entity_id: string;
      state_json: string;
    }[];
    return rows.map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      state: JSON.parse(r.state_json) as Record<string, unknown>,
    }));
  }

  entitiesOfType<T>(scenarioId: string, tick: number, entityType: string, forkId = LIVE_FORK): T[] {
    return this.stateAt(scenarioId, tick, forkId)
      .filter((e) => e.entityType === entityType)
      .map((e) => e.state as T);
  }

  /**
   * Copy current live state into an isolated fork and apply what-if patches.
   * The live timeline is never mutated (plan/07 §3) — operators adopt explicitly.
   */
  fork(scenarioId: string, eventIds: string[]): { forkId: string; changedEntities: string[] } {
    const d = this.dataset(scenarioId);
    const tick = this.currentTick(scenarioId);
    const events = eventIds.map((id) => {
      const evt = d.whatifs.whatifs.find((w) => w.id === id);
      if (!evt) throw new Error(`Unknown what-if event ${id}`);
      return evt;
    });
    // Deterministic fork id — same inputs, same id (helps replay evals).
    const forkId = `fork-${tick}-${eventIds.join("+")}`;
    const changed = new Set<string>();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM scenario_state WHERE scenario_id = ? AND fork_id = ?")
        .run(scenarioId, forkId);
      this.copyTick(scenarioId, LIVE_FORK, tick, tick, forkId);
      for (const evt of events) {
        for (const p of evt.patches) {
          this.applyPatch(scenarioId, forkId, tick, p);
          changed.add(`${p.entityType}:${p.entityId}`);
        }
      }
      this.writeDerivedLayers(scenarioId, forkId, tick);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO forks (fork_id, scenario_id, base_tick, event_ids_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(forkId, scenarioId, tick, JSON.stringify(eventIds), this.now());
    });
    tx();
    return { forkId, changedEntities: [...changed].sort() };
  }

  /** Apply a what-if to the LIVE state at the current tick (operator "adopt"). */
  inject(scenarioId: string, eventId: string): { changedEntities: string[] } {
    const d = this.dataset(scenarioId);
    const evt = d.whatifs.whatifs.find((w) => w.id === eventId);
    if (!evt) throw new Error(`Unknown what-if event ${eventId}`);
    const tick = this.currentTick(scenarioId);
    const changed = new Set<string>();
    const tx = this.db.transaction(() => {
      for (const p of evt.patches) {
        this.applyPatch(scenarioId, LIVE_FORK, tick, p);
        changed.add(`${p.entityType}:${p.entityId}`);
      }
      this.writeDerivedLayers(scenarioId, LIVE_FORK, tick);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO scenario_events (scenario_id, fork_id, tick, event_id, type, announcement) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(scenarioId, LIVE_FORK, tick, evt.id, "whatif.injected", evt.title);
    });
    tx();
    return { changedEntities: [...changed].sort() };
  }

  /**
   * Apply arbitrary patches to LIVE state at the current tick.
   * Used ONLY by approved (operator-tokened) action executions —
   * e.g. shelter assignment, resource dispatch (plan/09 tiers).
   */
  mutate(scenarioId: string, patches: StatePatch[], reason: string): { changedEntities: string[] } {
    return this.applyLivePatches(scenarioId, patches, reason, "action.mutation");
  }

  /**
   * Apply trusted, timestamped provider/import updates to LIVE state.
   * This is data ingestion, not an operator side effect: it updates the
   * situational picture and recomputes derived layers.
   */
  ingest(scenarioId: string, patches: StatePatch[], reason: string): { changedEntities: string[] } {
    return this.applyLivePatches(scenarioId, patches, reason, "provider.import");
  }

  private applyLivePatches(
    scenarioId: string,
    patches: StatePatch[],
    reason: string,
    eventType: "action.mutation" | "provider.import",
  ): { changedEntities: string[] } {
    const tick = this.currentTick(scenarioId);
    const changed = new Set<string>();
    const tx = this.db.transaction(() => {
      for (const p of patches) {
        this.applyPatch(scenarioId, LIVE_FORK, tick, p);
        changed.add(`${p.entityType}:${p.entityId}`);
      }
      this.writeDerivedLayers(scenarioId, LIVE_FORK, tick);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO scenario_events (scenario_id, fork_id, tick, event_id, type, announcement) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(scenarioId, LIVE_FORK, tick, `MUT-${tick}-${this.mutationSeq++}`, eventType, reason);
    });
    tx();
    return { changedEntities: [...changed].sort() };
  }

  private mutationSeq = 0;

  /** Reload + scripted advance; returns a canonical serialization for eval 14. */
  replay(scenarioId: string, toTick: number): string {
    this.load(scenarioId);
    if (toTick > 0) this.tick(scenarioId, toTick);
    const all: unknown[] = [];
    for (let t = 0; t <= toTick; t++) {
      all.push({ tick: t, entities: this.stateAt(scenarioId, t) });
    }
    return JSON.stringify(all);
  }

  listWhatIfs(scenarioId: string): WhatIfEvent[] {
    return this.dataset(scenarioId).whatifs.whatifs;
  }

  firedEvents(scenarioId: string): { tick: number; eventId: string; announcement: string }[] {
    return (
      this.db
        .prepare(
          "SELECT tick, event_id, announcement FROM scenario_events WHERE scenario_id = ? AND fork_id = '' ORDER BY tick, event_id",
        )
        .all(scenarioId) as { tick: number; event_id: string; announcement: string }[]
    ).map((r) => ({ tick: r.tick, eventId: r.event_id, announcement: r.announcement }));
  }

  // ---------- internals ----------

  private writeEntity(
    scenarioId: string,
    forkId: string,
    tick: number,
    entityType: string,
    entityId: string,
    state: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scenario_state (scenario_id, fork_id, tick, entity_type, entity_id, state_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(scenarioId, forkId, tick, entityType, entityId, canonicalJson(state));
  }

  private copyTick(
    scenarioId: string,
    fromFork: string,
    fromTick: number,
    toTick: number,
    toFork: string = fromFork,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scenario_state (scenario_id, fork_id, tick, entity_type, entity_id, state_json)
         SELECT scenario_id, ?, ?, entity_type, entity_id, state_json
         FROM scenario_state WHERE scenario_id = ? AND fork_id = ? AND tick = ?`,
      )
      .run(toFork, toTick, scenarioId, fromFork, fromTick);
  }

  private applyEvent(scenarioId: string, forkId: string, tick: number, evt: TimelineEvent): void {
    for (const p of evt.patches) this.applyPatch(scenarioId, forkId, tick, p);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO scenario_events (scenario_id, fork_id, tick, event_id, type, announcement) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(scenarioId, forkId, tick, evt.id, evt.type, evt.announcement);
  }

  private applyPatch(scenarioId: string, forkId: string, tick: number, p: StatePatch): void {
    if (p.op === "delete") {
      this.db
        .prepare(
          "DELETE FROM scenario_state WHERE scenario_id = ? AND fork_id = ? AND tick = ? AND entity_type = ? AND entity_id = ?",
        )
        .run(scenarioId, forkId, tick, p.entityType, p.entityId);
      return;
    }
    if (p.op === "set") {
      this.writeEntity(scenarioId, forkId, tick, p.entityType, p.entityId, p.data ?? {});
      return;
    }
    // merge
    const row = this.db
      .prepare(
        "SELECT state_json FROM scenario_state WHERE scenario_id = ? AND fork_id = ? AND tick = ? AND entity_type = ? AND entity_id = ?",
      )
      .get(scenarioId, forkId, tick, p.entityType, p.entityId) as
      | { state_json: string }
      | undefined;
    const current = row ? (JSON.parse(row.state_json) as Record<string, unknown>) : {};
    this.writeEntity(scenarioId, forkId, tick, p.entityType, p.entityId, {
      ...current,
      ...(p.data ?? {}),
    });
  }

  /**
   * Per-tick drift beyond scripted events (deterministic, plan/07 §2):
   * hospital backup fuel burns down 1 tick's worth per tick.
   */
  private applyDrift(scenarioId: string, forkId: string, tick: number): void {
    const minutesPerTick = (
      this.db.prepare("SELECT minutes_per_tick FROM scenarios WHERE id = ?").get(scenarioId) as {
        minutes_per_tick: number;
      }
    ).minutes_per_tick;
    const hoursPerTick = minutesPerTick / 60;
    const rows = this.stateAt(scenarioId, tick, forkId).filter(
      (e) => e.entityType === "facilityPower",
    );
    for (const r of rows) {
      const ps = FacilityPowerState.parse(r.state);
      if (ps.powerStatus === "backup" && ps.backupRemainingH !== null) {
        const remaining = Math.max(0, Math.round((ps.backupRemainingH - hoursPerTick) * 100) / 100);
        this.applyPatch(scenarioId, forkId, tick, {
          op: "merge",
          entityType: "facilityPower",
          entityId: ps.facilityId,
          data: { backupRemainingH: remaining, powerStatus: remaining === 0 ? "out" : "backup" },
        });
      }
    }
  }

  /** Recompute risk overlay entities for a tick (plan/07 §2 derived layers). */
  private writeDerivedLayers(scenarioId: string, forkId: string, tick: number): void {
    const d = this.dataset(scenarioId);
    const state = {
      outages: this.entitiesOfType<unknown>(scenarioId, tick, "outage", forkId).map((s) =>
        OutageState.parse(s),
      ),
      corridors: this.entitiesOfType<unknown>(scenarioId, tick, "corridor", forkId).map((s) =>
        CorridorState.parse(s),
      ),
      facilityPower: this.entitiesOfType<unknown>(scenarioId, tick, "facilityPower", forkId).map(
        (s) => FacilityPowerState.parse(s),
      ),
      weather: this.entitiesOfType<unknown>(scenarioId, tick, "weather", forkId).map((s) =>
        WeatherState.parse(s),
      ),
    };
    const overlay = computeRiskOverlay(d, state, tick);
    for (const z of overlay.perZone) {
      this.writeEntity(scenarioId, forkId, tick, "riskOverlay", z.zone, z as unknown as Record<string, unknown>);
    }
    this.writeEntity(scenarioId, forkId, tick, "riskOverlay", "city", {
      cityScore: overlay.cityScore,
    });
  }
}

/** Stable key order so identical states serialize to identical bytes (eval 14). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
