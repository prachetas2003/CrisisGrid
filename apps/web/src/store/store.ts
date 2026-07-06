import { create } from "zustand";
import {
  advanceTime,
  approveAction,
  fetchJson,
  forkScenario,
  getActions,
  getCommsDrafts,
  getFeed,
  getForkState,
  getReport,
  getSnapshot,
  injectScenarioEvent,
  loadScenario,
  getHealth,
  queueDraftForApproval,
  rejectAction,
  streamAssessment,
  subscribeSse,
} from "../lib/api";
import { buildLabels, type Labels } from "../lib/labels";
import type {
  ActionItem,
  CommsDraft,
  Conflict,
  DebateTurn,
  Finding,
  MapSnapshot,
  PipelineEvent,
  Plan,
  SafetyReview,
  WhatIf,
  EntityState,
} from "../lib/types";
import { REPLAY_EVENTS } from "../fixtures/replay";
import { enrichReplayDrafts, REPLAY_DEMO_ACTIONS } from "../fixtures/replayDemo";

export type Screen = "command" | "agents" | "decisions";

export interface AgentRunState {
  state: "idle" | "working" | "done" | "error";
  activity: string;
  toolCalls: number;
  findings: number;
}

export interface WhatIfResult {
  whatif: WhatIf;
  forkId: string;
  changedEntities: string[];
  /** Neighborhoods visually affected by this fork (for map highlight). */
  affectedZones: string[];
  /** zoneId -> { before, after } risk scores */
  riskDelta: { zone: string; before: number; after: number; beforeBand: string; afterBand: string }[];
  cityBefore: number;
  cityAfter: number;
}

interface State {
  // Boot / shared
  booted: boolean;
  bootError: string | null;
  snapshot: MapSnapshot | null;
  liveSnapshot: MapSnapshot | null;
  labels: Labels;
  screen: Screen;
  judgeOpen: boolean;
  selected: { kind: "zone" | "facility" | "route"; id: string } | null;
  viewTick: number | null; // scrubber position; null = live tick

  // Pipeline run
  runMode: "live" | "replay" | null;
  running: boolean;
  incidentId: string | null;
  phase: string | null;
  phasesSeen: string[];
  agents: Record<string, AgentRunState>;
  findings: Finding[];
  conflicts: Conflict[];
  debateTurns: DebateTurn[];
  safetyReviews: { review: SafetyReview; loop: number }[];
  planDraft: Plan | null;
  planFinal: Plan | null;
  briefing: { executiveSummary?: string; outlook?: string } | null;
  runSummary: { findings: number; conflicts: number; debateTurns: number; riskScore: number } | null;
  runError: string | null;
  toolCallCount: number;
  replayPaused: boolean;
  replaySpeed: number;
  replayIndex: number;
  agentsOnline: boolean;
  llmConfigured: boolean;

  // Decisions
  actions: ActionItem[];
  drafts: CommsDraft[];
  feed: { id: number; channel: string; body: string; published_at: string }[];
  report: { reportId: string; markdown: string } | null;
  reportLoading: boolean;

  // What-if
  whatifResult: WhatIfResult | null;
  whatifLoading: string | null;

  // Actions
  boot: () => Promise<void>;
  refreshSnapshot: (tick?: number) => Promise<void>;
  setScreen: (s: Screen) => void;
  setJudgeOpen: (open: boolean) => void;
  select: (sel: State["selected"]) => void;
  setViewTick: (tick: number | null) => void;
  advance: (ticks: number) => Promise<void>;
  startRun: (text: string) => void;
  startReplay: () => void;
  stopRun: () => void;
  toggleReplayPause: () => void;
  setReplaySpeed: (speed: number) => void;
  skipReplay: () => void;
  checkAgentsHealth: () => Promise<void>;
  refreshDecisions: () => Promise<void>;
  approve: (id: string) => Promise<void>;
  reject: (id: string, reason: string) => Promise<void>;
  queueDraft: (draftId: string) => Promise<void>;
  loadReport: () => Promise<void>;
  runWhatIf: (whatif: WhatIf) => Promise<void>;
  adoptWhatIf: () => Promise<void>;
  resetScenario: () => Promise<void>;
  clearWhatIf: () => void;
}

let abortRun: (() => void) | null = null;
let replayTimers: number[] = [];
let replayTimeout: number | null = null;
let currentReplayIndex = 0;

const emptyAgents = (): Record<string, AgentRunState> =>
  Object.fromEntries(
    ["intake", "weather", "power", "traffic", "shelter", "commander", "safety", "comms", "briefing"].map((id) => [
      id,
      { state: "idle", activity: "", toolCalls: 0, findings: 0 } satisfies AgentRunState,
    ]),
  );

export const useStore = create<State>((set, get) => ({
  booted: false,
  bootError: null,
  snapshot: null,
  liveSnapshot: null,
  labels: buildLabels(null),
  screen: "command",
  judgeOpen: false,
  selected: null,
  viewTick: null,

  runMode: null,
  running: false,
  incidentId: null,
  phase: null,
  phasesSeen: [],
  agents: emptyAgents(),
  findings: [],
  conflicts: [],
  debateTurns: [],
  safetyReviews: [],
  planDraft: null,
  planFinal: null,
  briefing: null,
  runSummary: null,
  runError: null,
  toolCallCount: 0,
  replayPaused: false,
  replaySpeed: 1,
  replayIndex: 0,
  agentsOnline: true,
  llmConfigured: true,

  actions: [],
  drafts: [],
  feed: [],
  report: null,
  reportLoading: false,

  whatifResult: null,
  whatifLoading: null,

  boot: async () => {
    try {
      const snapshot = await getSnapshot();
      set({ snapshot, liveSnapshot: snapshot, labels: buildLabels(snapshot), booted: true, bootError: null });
      void get().refreshDecisions();
      void get().checkAgentsHealth();
      subscribeSse((type) => {
        if (type.startsWith("action.")) void get().refreshDecisions();
        if (type === "scenario.tick" || type === "scenario.event") void get().refreshSnapshot();
      });
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err) });
    }
  },

  refreshSnapshot: async (tick?: number) => {
    try {
      const snapshot = await getSnapshot(tick);
      set({ liveSnapshot: snapshot });
      if (!get().whatifResult) {
        set({ snapshot, labels: buildLabels(snapshot) });
      }
    } catch {
      /* transient — keep last snapshot */
    }
  },

  setScreen: (screen) => set({ screen }),
  setJudgeOpen: (judgeOpen) => set({ judgeOpen }),
  select: (selected) => set({ selected }),

  setViewTick: (viewTick) => {
    set({ viewTick });
    void get().refreshSnapshot(viewTick ?? undefined);
  },

  advance: async (ticks) => {
    const snap = get().snapshot;
    if (!snap) return;
    await advanceTime(snap.scenario.id, ticks);
    set({ viewTick: null });
    await get().refreshSnapshot();
  },

  startRun: (text) => {
    get().stopRun();
    resetRun(set, "live");
    abortRun = streamAssessment(
      text,
      (event) => applyEvent(set, get, event),
      (error) => {
        if (error) {
          set({ running: false, runError: error });
        } else {
          set({ running: false });
        }
        abortRun = null;
      },
    );
  },

  startReplay: () => {
    get().stopRun();
    resetRun(set, "replay");
    set({ replayPaused: false, replaySpeed: 1, replayIndex: 0 });
    currentReplayIndex = 0;

    const scheduleNext = () => {
      if (currentReplayIndex >= REPLAY_EVENTS.length) {
        set({ running: false });
        return;
      }

      const { t, event } = REPLAY_EVENTS[currentReplayIndex]!;
      const prevT = currentReplayIndex > 0 ? REPLAY_EVENTS[currentReplayIndex - 1]!.t : 0;
      const baseGap = Math.min(Math.max((t - prevT) * 0.6, 30), 2500);
      const gap = baseGap / get().replaySpeed;

      replayTimeout = window.setTimeout(() => {
        applyEvent(set, get, event as PipelineEvent);
        currentReplayIndex++;
        set({ replayIndex: currentReplayIndex });
        scheduleNext();
      }, gap);
    };

    scheduleNext();
  },

  stopRun: () => {
    abortRun?.();
    abortRun = null;
    if (replayTimeout !== null) {
      clearTimeout(replayTimeout);
      replayTimeout = null;
    }
    for (const timer of replayTimers) clearTimeout(timer);
    replayTimers = [];
    set({ running: false, replayPaused: false });
  },

  toggleReplayPause: () => {
    if (get().runMode !== "replay" || !get().running) return;
    const isPaused = get().replayPaused;
    if (isPaused) {
      set({ replayPaused: false });
      const scheduleNext = () => {
        if (currentReplayIndex >= REPLAY_EVENTS.length) {
          set({ running: false });
          return;
        }
        const { t, event } = REPLAY_EVENTS[currentReplayIndex]!;
        const prevT = currentReplayIndex > 0 ? REPLAY_EVENTS[currentReplayIndex - 1]!.t : 0;
        const baseGap = Math.min(Math.max((t - prevT) * 0.6, 30), 2500);
        const gap = baseGap / get().replaySpeed;

        replayTimeout = window.setTimeout(() => {
          applyEvent(set, get, event as PipelineEvent);
          currentReplayIndex++;
          set({ replayIndex: currentReplayIndex });
          scheduleNext();
        }, gap);
      };
      scheduleNext();
    } else {
      set({ replayPaused: true });
      if (replayTimeout !== null) {
        clearTimeout(replayTimeout);
        replayTimeout = null;
      }
    }
  },

  setReplaySpeed: (speed) => {
    set({ replaySpeed: speed });
    if (get().runMode === "replay" && get().running && !get().replayPaused) {
      if (replayTimeout !== null) {
        clearTimeout(replayTimeout);
        replayTimeout = null;
      }
      const scheduleNext = () => {
        if (currentReplayIndex >= REPLAY_EVENTS.length) {
          set({ running: false });
          return;
        }
        const { t, event } = REPLAY_EVENTS[currentReplayIndex]!;
        const prevT = currentReplayIndex > 0 ? REPLAY_EVENTS[currentReplayIndex - 1]!.t : 0;
        const baseGap = Math.min(Math.max((t - prevT) * 0.6, 30), 2500);
        const gap = baseGap / get().replaySpeed;

        replayTimeout = window.setTimeout(() => {
          applyEvent(set, get, event as PipelineEvent);
          currentReplayIndex++;
          set({ replayIndex: currentReplayIndex });
          scheduleNext();
        }, gap);
      };
      scheduleNext();
    }
  },

  skipReplay: () => {
    if (get().runMode !== "replay" || !get().running) return;
    if (replayTimeout !== null) {
      clearTimeout(replayTimeout);
      replayTimeout = null;
    }
    for (let i = currentReplayIndex; i < REPLAY_EVENTS.length; i++) {
      const { event } = REPLAY_EVENTS[i]!;
      applyEvent(set, get, event as PipelineEvent);
    }
    currentReplayIndex = REPLAY_EVENTS.length;
    set({ replayIndex: currentReplayIndex, running: false, replayPaused: false });
  },

  checkAgentsHealth: async () => {
    try {
      const health = await getHealth();
      if (health.agents) {
        set({ agentsOnline: health.agents.online, llmConfigured: health.agents.llmConfigured });
      } else {
        set({ agentsOnline: false, llmConfigured: false });
      }
    } catch {
      set({ agentsOnline: false, llmConfigured: false });
    }
  },

  refreshDecisions: async () => {
    if (get().runMode === "replay") return;
    try {
      const [a, d, f] = await Promise.all([getActions(), getCommsDrafts(), getFeed()]);
      const humanize = get().labels.humanize;
      set({
        actions: a.actions.map((act) => ({
          ...act,
          payload: {
            ...act.payload,
            title: act.payload.title ? humanize(act.payload.title) : act.payload.title,
            preview:
              typeof act.payload.preview === "string" ? humanize(act.payload.preview) : act.payload.preview,
          },
        })),
        drafts: d.drafts.map((draft) => ({ ...draft, body: humanize(draft.body) })),
        feed: f.feed.map((item) => ({ ...item, body: humanize(item.body) })),
      });
    } catch {
      /* server may be booting */
    }
  },

  approve: async (id) => {
    if (get().runMode === "replay") {
      set((s) => {
        const updated = s.actions.map((a) =>
          a.id === id ? { ...a, status: "executed" as const, approved_by: "you", executed_at: new Date().toISOString() } : a
        );
        const approvedAction = s.actions.find((a) => a.id === id);
        let feed = s.feed;
        if (approvedAction) {
          const preview =
            typeof approvedAction.payload.preview === "string"
              ? approvedAction.payload.preview
              : (approvedAction.payload.title ?? "Alert published.");
          feed = [
            ...s.feed,
            {
              id: Date.now(),
              channel: "sms",
              body: get().labels.humanize(preview),
              published_at: new Date().toISOString(),
            },
          ];
        }
        return { actions: updated, feed };
      });
      return;
    }
    await approveAction(id, "you");
    await get().refreshDecisions();
  },

  reject: async (id, reason) => {
    if (get().runMode === "replay") {
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === id ? { ...a, status: "rejected" as const, blocked_reason: reason } : a
        ),
      }));
      return;
    }
    await rejectAction(id, "you", reason);
    await get().refreshDecisions();
  },

  queueDraft: async (draftId) => {
    if (get().runMode === "replay") {
      set((s) => {
        const draft = s.drafts.find((d) => d.draftId === draftId);
        if (!draft) return {};
        const newAction = {
          id: `act-${draftId}`,
          kind: "comms_approval",
          tier: "needs_approval" as const,
          status: "queued" as const,
          payload: {
            title: `Publish ${draft.channel} alert to ${draft.audience}`,
            tool: "comms.send_sandbox_alert",
            args: { draftId },
            preview: get().labels.humanize(draft.body),
          },
          matchedRules: [{ id: "policy", reason: "Requires operator approval before public broadcast" }],
          requested_by: "operator",
          approved_by: null,
          approved_at: null,
          executed_at: null,
          blocked_reason: null,
          created_at: new Date().toISOString(),
        };
        return {
          actions: [newAction, ...s.actions],
        };
      });
      return;
    }
    await queueDraftForApproval(draftId);
    await get().refreshDecisions();
  },

  loadReport: async () => {
    const incidentId = get().incidentId ?? (await latestIncidentId());
    if (!incidentId) return;
    set({ reportLoading: true });
    try {
      const report = await getReport(incidentId);
      set({
        report: { ...report, markdown: get().labels.humanize(report.markdown) },
        reportLoading: false,
      });
    } catch (err) {
      set({ reportLoading: false, runError: err instanceof Error ? err.message : String(err) });
    }
  },

  runWhatIf: async (whatif) => {
    const snap = get().snapshot;
    if (!snap) return;
    const liveSnapshot = get().liveSnapshot ?? snap;
    set({ whatifLoading: whatif.id, whatifResult: null, liveSnapshot });
    try {
      const fork = await forkScenario(snap.scenario.id, [whatif.id]);
      const forkState = await getForkState(snap.scenario.id, fork.forkId);
      const before = riskByZone(liveSnapshot.state.byType.riskOverlay ?? []);
      const after = riskByZone(
        forkState.entities.filter((e) => e.entityType === "riskOverlay").map((e) => ({ entityId: e.entityId, ...e.state })),
      );
      const zones = [...new Set([...before.keys(), ...after.keys()])].filter((z) => z !== "city");
      const riskDelta = zones
        .map((zone) => ({
          zone,
          before: before.get(zone)?.score ?? 0,
          after: after.get(zone)?.score ?? 0,
          beforeBand: before.get(zone)?.band ?? "low",
          afterBand: after.get(zone)?.band ?? "low",
        }))
        .filter((d) => Math.abs(d.after - d.before) >= 1)
        .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

      const forkedByType: Record<string, EntityState[]> = {};
      for (const e of forkState.entities) {
        forkedByType[e.entityType] ??= [];
        forkedByType[e.entityType]!.push({
          entityId: e.entityId,
          ...e.state,
        });
      }

      const forkedSnapshot = {
        ...liveSnapshot,
        state: {
          ...liveSnapshot.state,
          byType: forkedByType,
        },
      };

      const affectedZones = zonesAffectedByChanges(forkedSnapshot, fork.changedEntities ?? []);

      set({
        whatifLoading: null,
        snapshot: forkedSnapshot,
        whatifResult: {
          whatif,
          forkId: fork.forkId,
          changedEntities: fork.changedEntities ?? [],
          affectedZones,
          riskDelta,
          cityBefore: before.get("city")?.score ?? 0,
          cityAfter: after.get("city")?.score ?? 0,
        },
      });
    } catch (err) {
      set({ whatifLoading: null, runError: err instanceof Error ? err.message : String(err) });
    }
  },

  adoptWhatIf: async () => {
    const result = get().whatifResult;
    const snap = get().liveSnapshot ?? get().snapshot;
    if (!result || !snap) return;
    set({ whatifLoading: result.whatif.id });
    try {
      await injectScenarioEvent(snap.scenario.id, result.whatif.id);
      const snapshot = await getSnapshot();
      set({
        snapshot,
        liveSnapshot: snapshot,
        labels: buildLabels(snapshot),
        whatifResult: null,
        whatifLoading: null,
        viewTick: null,
      });
    } catch (err) {
      set({ whatifLoading: null, runError: err instanceof Error ? err.message : String(err) });
    }
  },

  resetScenario: async () => {
    const snap = get().snapshot;
    if (!snap) return;
    set({ whatifLoading: "reset" });
    try {
      await loadScenario(snap.scenario.id);
      const snapshot = await getSnapshot();
      set({
        snapshot,
        liveSnapshot: snapshot,
        labels: buildLabels(snapshot),
        whatifResult: null,
        whatifLoading: null,
        viewTick: null,
        selected: null,
      });
    } catch (err) {
      set({ whatifLoading: null, runError: err instanceof Error ? err.message : String(err) });
    }
  },

  clearWhatIf: () => {
    const liveSnapshot = get().liveSnapshot ?? get().snapshot;
    if (liveSnapshot) {
      set({ snapshot: liveSnapshot, whatifResult: null });
    } else {
      set({ whatifResult: null });
    }
  },
}));

function resetRun(set: (partial: Partial<State>) => void, runMode: "live" | "replay") {
  set({
    runMode,
    running: true,
    incidentId: null,
    phase: null,
    phasesSeen: [],
    agents: emptyAgents(),
    findings: [],
    conflicts: [],
    debateTurns: [],
    safetyReviews: [],
    planDraft: null,
    planFinal: null,
    briefing: null,
    runSummary: null,
    runError: null,
    toolCallCount: 0,
    report: null,
  });
}

function applyEvent(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
  event: PipelineEvent,
): void {
  set((s) => {
    switch (event.type) {
      case "run.start":
        return { incidentId: event.incidentId };
      case "phase": {
        const phasesSeen = s.phasesSeen.includes(event.phase) ? s.phasesSeen : [...s.phasesSeen, event.phase];
        // Milestone agents (intake/commander/safety/comms/briefing) don't emit
        // status events — infer their state from phase transitions.
        const agents = { ...s.agents };
        const setState = (id: string, state: AgentRunState["state"]) => {
          const cur = agents[id];
          if (cur && cur.state !== "error") agents[id] = { ...cur, state };
        };
        if (event.phase === "intake") setState("intake", "working");
        if (event.phase === "assessment") setState("intake", "done");
        if (event.phase === "synthesis") setState("commander", "working");
        if (event.phase === "comms") {
          setState("commander", "done");
          setState("safety", "done");
          setState("comms", "working");
        }
        if (event.phase === "briefing") {
          setState("comms", "done");
          setState("briefing", "working");
        }
        return { phase: event.phase, phasesSeen, agents };
      }
      case "agent.status": {
        const cur = s.agents[event.agentId] ?? { state: "idle", activity: "", toolCalls: 0, findings: 0 };
        return {
          agents: {
            ...s.agents,
            [event.agentId]: {
              ...cur,
              state: event.state,
              activity: event.state === "done" ? "" : cur.activity,
            },
          },
        };
      }
      case "agent.tool_call": {
        const id = baseAgentId(event.agentId);
        const cur = s.agents[id];
        if (!cur) return {};
        return {
          toolCallCount: s.toolCallCount + 1,
          agents: { ...s.agents, [id]: { ...cur, toolCalls: cur.toolCalls + 1, activity: event.tool } },
        };
      }
      case "agent.finding": {
        const id = baseAgentId(event.finding.agentId);
        const cur = s.agents[id];
        const findings = s.findings.some((f) => f.id === event.finding.id)
          ? s.findings.map((f) => (f.id === event.finding.id ? event.finding : f))
          : [...s.findings, event.finding];
        return {
          findings,
          ...(cur ? { agents: { ...s.agents, [id]: { ...cur, findings: cur.findings + 1 } } } : {}),
        };
      }
      case "agent.error": {
        const id = baseAgentId(event.agentId);
        const cur = s.agents[id];
        if (!cur) return {};
        return { agents: { ...s.agents, [id]: { ...cur, state: "error", activity: "" } } };
      }
      case "conflict.detected":
        return { conflicts: [...s.conflicts, event.conflict] };
      case "debate.turn":
        return { debateTurns: [...s.debateTurns, event.turn] };
      case "plan.draft":
        return { planDraft: event.plan };
      case "safety.review": {
        const safety = s.agents.safety;
        return {
          safetyReviews: [...s.safetyReviews, { review: event.review, loop: event.loop }],
          ...(safety
            ? { agents: { ...s.agents, safety: { ...safety, state: event.review.verdict === "approved" ? "done" : "working" } } }
            : {}),
        };
      }
      case "plan.final": {
        let extra: Partial<State> = {};
        if (s.runMode === "replay") {
          const fromPlan = event.plan.actions
            .filter((a) => a.tier === "needs_approval")
            .map((a) => ({
              id: a.id,
              kind: "tool_execution",
              tier: a.tier as "needs_approval",
              status: "queued" as const,
              payload: {
                title: get().labels.humanize(a.title),
                tool: "safety.require_approval",
                args: {},
                preview: get().labels.humanize(a.description),
              },
              matchedRules: [{ id: "policy", reason: `Requires human approval: ${get().labels.humanize(a.description)}` }],
              requested_by: "agents",
              approved_by: null,
              approved_at: null,
              executed_at: null,
              blocked_reason: null,
              created_at: new Date().toISOString(),
            }));
          if (fromPlan.length > 0) extra = { actions: fromPlan };
        }
        return { planFinal: event.plan, ...extra };
      }
      case "comms.drafts": {
        if (s.runMode === "replay") {
          try {
            const parsed = JSON.parse(event.raw) as { drafts?: CommsDraft[] };
            if (parsed.drafts) {
              const enriched = enrichReplayDrafts(parsed.drafts).map((d) => ({
                ...d,
                body: get().labels.humanize(d.body),
              }));
              return { drafts: enriched };
            }
          } catch {
            /* ignore */
          }
        }
        return {};
      }
      case "briefing.sections":
        return {
          briefing: {
            executiveSummary: event.sections.executiveSummary
              ? get().labels.humanize(event.sections.executiveSummary)
              : undefined,
            outlook: event.sections.outlook ? get().labels.humanize(event.sections.outlook) : undefined,
          },
        };
      case "run.complete": {
        void get().refreshDecisions();
        const agents = Object.fromEntries(
          Object.entries(s.agents).map(([id, a]) => [id, a.state === "working" ? { ...a, state: "done" as const } : a]),
        );
        const humanizedBriefing = s.briefing;
        let replayExtras: Partial<State> = {};
        if (s.runMode === "replay" && s.actions.filter((a) => a.status === "queued").length === 0) {
          replayExtras = {
            actions: REPLAY_DEMO_ACTIONS.map((a) => ({
              ...a,
              payload: {
                ...a.payload,
                title: get().labels.humanize(a.payload.title ?? ""),
                preview:
                  typeof a.payload.preview === "string"
                    ? get().labels.humanize(a.payload.preview)
                    : a.payload.preview,
              },
            })),
          };
        }
        return {
          running: false,
          agents,
          briefing: humanizedBriefing,
          runSummary: {
            findings: event.findings,
            conflicts: event.conflicts,
            debateTurns: event.debateTurns,
            riskScore: event.riskScore,
          },
          ...replayExtras,
        };
      }
      case "run.error":
        return { running: false, runError: event.error };
      default:
        return {};
    }
  });
}

/** "weather" from "weather" or "weather(retry)" etc. */
function baseAgentId(id: string): string {
  return id.split("(")[0]!.trim();
}

function riskByZone(entities: { entityId: string; [k: string]: unknown }[]): Map<string, { score: number; band: string }> {
  const map = new Map<string, { score: number; band: string }>();
  for (const e of entities) {
    const score = typeof e.score0to100 === "number" ? e.score0to100 : typeof e.cityScore === "number" ? e.cityScore : null;
    if (score === null) continue;
    map.set(e.entityId, { score, band: typeof e.band === "string" ? e.band : "low" });
  }
  return map;
}

function zonesAffectedByChanges(snapshot: MapSnapshot, changedEntities: string[]): string[] {
  const zones = new Set<string>();
  for (const key of changedEntities) {
    const [type, id] = key.split(":");
    if (!type || !id) continue;
    if (type === "outage") {
      const o = snapshot.state.byType.outage?.find((e) => e.entityId === id);
      for (const z of (o?.zones as { zone: string; level: string }[] | undefined) ?? []) {
        if (z.level !== "restored") zones.add(z.zone);
      }
    }
    if (type === "shelter" || type === "facilityPower") {
      const fac = snapshot.geometry.facilities.facilities.find((f) => f.id === id);
      if (fac?.zone) zones.add(fac.zone);
    }
    if (type === "corridor") {
      const c = snapshot.geometry.network.corridors.find((x) => x.id === id);
      for (const z of c?.zones ?? []) zones.add(z);
    }
    if (type === "closure") {
      const cl = snapshot.state.byType.closure?.find((e) => e.entityId === id);
      const corridorId = String(cl?.corridorId ?? "");
      const c = snapshot.geometry.network.corridors.find((x) => x.id === corridorId);
      for (const z of c?.zones ?? []) zones.add(z);
    }
    if (type === "weather") {
      for (const z of ["Z-01", "Z-05", "Z-06", "Z-07"]) zones.add(z);
    }
  }
  return [...zones];
}

async function latestIncidentId(): Promise<string | null> {
  try {
    const res = await fetchJson<{ incidents: { id: string; status: string }[] }>("/api/incidents");
    return res.incidents.find((i) => i.status === "complete")?.id ?? res.incidents[0]?.id ?? null;
  } catch {
    return null;
  }
}
