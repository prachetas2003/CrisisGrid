import { useEffect, useRef } from "react";
import { useStore } from "../store/store";
import { AGENTS, PHASES, SEVERITY_COLOR, SEVERITY_LABEL, agentMeta, phaseIndex, toolLabel } from "../lib/labels";
import { Icon } from "../components/Icon";
import { PlanCard } from "../components/PlanCard";
import type { Conflict, DebateTurn, Finding } from "../lib/types";

export function AgentRoom() {
  const {
    runMode,
    running,
    phase,
    agents,
    findings,
    conflicts,
    debateTurns,
    safetyReviews,
    planFinal,
    planDraft,
    briefing,
    runSummary,
    runError,
    toolCallCount,
    setScreen,
    startReplay,
  } = useStore();

  if (!runMode && !runSummary) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
            <Icon name="bot" size={26} color="#38bdf8" />
          </div>
          <h2 className="mb-2 text-lg font-bold">The Agent Room is quiet</h2>
          <p className="mb-5 text-[13px] leading-relaxed text-mute">
            This is where you watch nine AI agents investigate a crisis in parallel, catch each other's conflicts,
            debate with evidence, and produce a safety-checked plan.
          </p>
          <div className="flex justify-center gap-2">
            <button
              onClick={() => setScreen("command")}
              className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-bold text-ink transition hover:brightness-110"
            >
              Describe a crisis
            </button>
            <button
              onClick={() => startReplay()}
              className="rounded-lg border border-edge px-4 py-2.5 text-[13px] font-semibold text-mute transition hover:border-edge2 hover:text-text"
            >
              Watch a recorded run
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PhaseBar phase={phase} running={running} toolCallCount={toolCallCount} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Agent tiles */}
        <div className="grid max-h-[40vh] shrink-0 grid-cols-2 content-start gap-2 overflow-y-auto border-b border-edge bg-panel p-3 sm:grid-cols-3 sm:p-4 lg:max-h-none lg:w-[360px] lg:grid-cols-2 lg:border-b-0 lg:border-r xl:w-[480px] xl:grid-cols-3">
          {AGENTS.map((meta) => {
            const st = agents[meta.id] ?? { state: "idle", activity: "", toolCalls: 0, findings: 0 };
            return (
              <div
                key={meta.id}
                className={`rounded-xl border p-3 transition-all ${
                  st.state === "working"
                    ? "border-transparent bg-panel2 shadow-lg"
                    : st.state === "done"
                      ? "border-edge bg-panel2/60"
                      : st.state === "error"
                        ? "border-danger/40 bg-danger/5"
                        : "border-edge/60 bg-panel2/30 opacity-60"
                }`}
                style={st.state === "working" ? { boxShadow: `0 0 0 1.5px ${meta.color}66, 0 4px 20px ${meta.color}22` } : undefined}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{ background: `${meta.color}1a` }}
                  >
                    <Icon name={meta.icon} size={14} color={meta.color} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-bold leading-tight">{meta.name}</div>
                    <div className="truncate text-[10px] leading-tight text-dim">{meta.role}</div>
                  </div>
                  <StatusDot state={st.state} color={meta.color} />
                </div>
                <div className="min-h-[28px] text-[10.5px] leading-snug text-mute">
                  {st.state === "working" && st.activity ? (
                    <span className="text-text">{toolLabel(st.activity)}…</span>
                  ) : st.state === "working" ? (
                    <span>Thinking…</span>
                  ) : st.state === "done" ? (
                    <span className="text-dim">
                      Done{st.toolCalls > 0 ? ` · ${st.toolCalls} tool calls` : ""}
                      {st.findings > 0 ? ` · ${st.findings} findings` : ""}
                    </span>
                  ) : st.state === "error" ? (
                    <span className="text-danger">Hit an error</span>
                  ) : (
                    <span className="text-dim">Waiting</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Live feed */}
        <Feed
          findings={findings}
          conflicts={conflicts}
          debateTurns={debateTurns}
          safetyReviews={safetyReviews}
          planFinal={planFinal}
          planDraft={planDraft}
          briefing={briefing}
          runError={runError}
          runSummary={runSummary}
          running={running}
        />
      </div>
    </div>
  );
}

function StatusDot({ state, color }: { state: string; color: string }) {
  if (state === "working")
    return <span className="pulse-dot ml-auto h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
  if (state === "done") return <Icon name="check" size={12} className="ml-auto shrink-0 text-ok" />;
  if (state === "error") return <Icon name="alert" size={12} className="ml-auto shrink-0 text-danger" />;
  return <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-edge" />;
}

function PhaseBar({ phase, running, toolCallCount }: { phase: string | null; running: boolean; toolCallCount: number }) {
  const idx = phase ? phaseIndex(phase) : -1;
  const current = idx >= 0 ? PHASES[idx] : null;
  return (
    <div className="shrink-0 border-b border-edge bg-panel px-5 py-3">
      <div className="flex items-center gap-1">
        {PHASES.map((p, i) => {
          const done = idx > i || (!running && idx >= i);
          const active = running && idx === i;
          return (
            <div key={p.id} className="flex flex-1 items-center gap-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold transition ${
                    active
                      ? "bg-accent text-ink"
                      : done
                        ? "bg-ok/20 text-ok"
                        : "bg-panel2 text-dim"
                  }`}
                >
                  {done && !active ? <Icon name="check" size={10} /> : i + 1}
                </span>
                <span className={`text-[11px] font-semibold ${active ? "text-text" : done ? "text-mute" : "text-dim"}`}>
                  {p.label}
                </span>
              </div>
              {i < PHASES.length - 1 && <div className={`h-px flex-1 ${done ? "bg-ok/30" : "bg-edge"}`} />}
            </div>
          );
        })}
        <span className="ml-3 shrink-0 font-mono text-[10px] text-dim">{toolCallCount} tool calls</span>
      </div>
      {current && running && <p className="mt-1.5 text-[11px] text-dim">{current.blurb}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Feed(props: {
  findings: Finding[];
  conflicts: Conflict[];
  debateTurns: DebateTurn[];
  safetyReviews: { review: { verdict: string; revisions: { issue: string; requiredChange: string }[]; notes: string }; loop: number }[];
  planFinal: ReturnType<typeof useStore.getState>["planFinal"];
  planDraft: ReturnType<typeof useStore.getState>["planDraft"];
  briefing: ReturnType<typeof useStore.getState>["briefing"];
  runError: string | null;
  runSummary: { findings: number; conflicts: number; debateTurns: number; riskScore: number } | null;
  running: boolean;
}) {
  const { labels, setScreen } = useStore();
  const endRef = useRef<HTMLDivElement>(null);
  const feedLength =
    props.findings.length +
    props.debateTurns.length +
    props.safetyReviews.length +
    (props.planFinal ? 1 : 0) +
    (props.briefing?.executiveSummary ? 1 : 0);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [feedLength, props.runError]);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-2xl space-y-3">
        {props.findings.length === 0 && props.running && (
          <div className="flex items-center gap-3 rounded-xl border border-edge bg-panel p-4 text-[13px] text-mute">
            <span className="pulse-dot h-2 w-2 rounded-full bg-accent" />
            Agents are investigating — findings stream in here as they land.
          </div>
        )}

        {props.findings.map((f) => (
          <FindingCard key={f.id} finding={f} humanize={labels.humanize} />
        ))}

        {props.conflicts.map((c) => (
          <DebateSection
            key={c.conflictId}
            conflict={c}
            turns={props.debateTurns.filter((t) => t.conflictId === c.conflictId)}
            resolution={props.planFinal?.conflictResolutions.find((r) => r.conflictId === c.conflictId) ?? props.planDraft?.conflictResolutions.find((r) => r.conflictId === c.conflictId)}
            humanize={labels.humanize}
          />
        ))}

        {props.safetyReviews.map(({ review, loop }) => (
          <div
            key={loop}
            className={`anim-in rounded-xl border p-4 ${review.verdict === "approved" ? "border-ok/30 bg-ok/5" : "border-alert/30 bg-alert/5"}`}
          >
            <div className="mb-1 flex items-center gap-2">
              <Icon name="shield" size={14} className={review.verdict === "approved" ? "text-ok" : "text-alert"} />
              <span className="text-[12px] font-bold">
                Safety review #{loop}:{" "}
                <span className={review.verdict === "approved" ? "text-ok" : "text-alert"}>
                  {review.verdict === "approved" ? "Plan approved" : "Revision required"}
                </span>
              </span>
            </div>
            {review.revisions.map((r, i) => (
              <p key={i} className="ml-6 text-[12px] leading-snug text-mute">
                • {labels.humanize(r.issue)} → <span className="text-text">{labels.humanize(r.requiredChange)}</span>
              </p>
            ))}
            {review.notes && <p className="ml-6 mt-1 text-[11.5px] text-dim">{labels.humanize(review.notes)}</p>}
          </div>
        ))}

        {props.runSummary && props.briefing?.executiveSummary && (
          <div className="anim-in rounded-xl border border-accent/30 bg-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="file" size={14} className="text-accent" />
              <span className="text-[12px] font-bold text-accent">Executive summary</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-mute">{props.briefing.executiveSummary}</p>
            {props.briefing.outlook && (
              <>
                <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-widest text-dim">Outlook</div>
                <p className="text-[12px] leading-relaxed text-dim">{props.briefing.outlook}</p>
              </>
            )}
          </div>
        )}

        {props.planFinal && (
          <PlanCard
            plan={props.planFinal}
            humanize={labels.humanize}
            onGoToDecisions={props.runSummary ? undefined : () => setScreen("decisions")}
          />
        )}

        {props.runSummary && (
          <div className="anim-in rounded-xl border border-accent/30 bg-accent/5 p-4">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-accent">
              <Icon name="check" size={15} />
              Assessment complete
            </div>
            <p className="text-[12.5px] leading-relaxed text-mute">
              {props.runSummary.findings} findings · {props.runSummary.conflicts} conflict
              {props.runSummary.conflicts === 1 ? "" : "s"} caught and debated · risk scored{" "}
              {Math.round(props.runSummary.riskScore)} / 100.{" "}
              <button className="font-semibold text-accent underline" onClick={() => setScreen("decisions")}>
                Review and approve the actions →
              </button>
            </p>
          </div>
        )}

        {props.runError && (
          <div className="anim-in rounded-xl border border-danger/40 bg-danger/5 p-4">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-danger">
              <Icon name="alert" size={15} />
              The live run hit a problem
            </div>
            <p className="mb-2 text-[12px] leading-snug text-mute">{props.runError}</p>
            <p className="text-[11.5px] text-dim">
              You can still watch a recorded real run from the Command Center — it replays actual agent output, honestly
              labeled.
            </p>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function FindingCard({ finding, humanize }: { finding: Finding; humanize: (s: string) => string }) {
  const meta = agentMeta(finding.agentId);
  const sev = SEVERITY_COLOR[finding.severity] ?? "#64748b";
  return (
    <div className="anim-in rounded-xl border border-edge bg-panel p-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ background: `${meta.color}1a` }}>
          <Icon name={meta.icon} size={12} color={meta.color} />
        </span>
        <span className="text-[11px] font-bold" style={{ color: meta.color }}>
          {meta.name}
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{ background: `${sev}1f`, color: sev }}
        >
          {SEVERITY_LABEL[finding.severity]}
        </span>
      </div>
      <p className="text-[13px] font-semibold leading-snug">{humanize(finding.finding)}</p>
      {finding.detail && <p className="mt-1 text-[12px] leading-relaxed text-mute">{humanize(finding.detail)}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {finding.evidence.slice(0, 4).map((e, i) => (
          <span
            key={i}
            title={humanize(e.summary || e.ref)}
            className="cursor-help rounded-md border border-edge bg-panel2 px-1.5 py-0.5 text-[9.5px] text-dim transition hover:border-edge2 hover:text-mute"
          >
            {e.kind === "tool_call"
              ? toolLabel(e.summary.split("(")[0] ?? e.summary)
              : humanize(e.summary || e.kind).slice(0, 28)}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-dim">{Math.round(finding.confidence * 100)}% confident</span>
      </div>
    </div>
  );
}

function DebateSection({
  conflict,
  turns,
  resolution,
  humanize,
}: {
  conflict: Conflict;
  turns: DebateTurn[];
  resolution?: { decision: string; rationale: string };
  humanize: (s: string) => string;
}) {
  return (
    <div className="anim-in rounded-xl border border-warn/30 bg-warn/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="scale" size={15} className="text-warn" />
        <span className="text-[12px] font-bold text-warn">Conflict caught — agents disagree</span>
      </div>
      <p className="mb-3 text-[12.5px] leading-snug text-mute">{humanize(conflict.summary)}</p>

      <div className="space-y-2">
        {turns.map((t, i) => {
          const meta = agentMeta(t.fromAgent);
          const stanceColor = t.stance === "contest" ? "#ef4444" : t.stance === "amend" ? "#fbbf24" : "#34d399";
          return (
            <div key={i} className="flex gap-2.5 rounded-lg bg-ink/60 p-3">
              <span
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                style={{ background: `${meta.color}1a` }}
              >
                <Icon name={meta.icon} size={12} color={meta.color} />
              </span>
              <div className="min-w-0">
                <div className="mb-0.5 flex items-center gap-2">
                  <span className="text-[11px] font-bold" style={{ color: meta.color }}>
                    {meta.name}
                  </span>
                  <span
                    className="rounded px-1.5 py-px text-[9px] font-bold uppercase"
                    style={{ background: `${stanceColor}1f`, color: stanceColor }}
                  >
                    {t.stance === "contest" ? "objects" : t.stance === "amend" ? "amends" : "confirms"}
                  </span>
                </div>
                <p className="text-[12px] leading-snug text-mute">{humanize(t.text)}</p>
              </div>
            </div>
          );
        })}
      </div>

      {resolution && (
        <div className="mt-3 rounded-lg border border-edge bg-panel p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-violet">
            <Icon name="shield" size={12} />
            Commander's ruling
          </div>
          <p className="text-[12px] font-semibold leading-snug">{humanize(resolution.decision)}</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-dim">{humanize(resolution.rationale)}</p>
        </div>
      )}
    </div>
  );
}
