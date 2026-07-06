import { useEffect, useState } from "react";
import { marked } from "marked";
import { useStore } from "../store/store";
import { Icon } from "../components/Icon";
import { toolLabel } from "../lib/labels";
import type { ActionItem } from "../lib/types";

/** What actually happens if you approve — spelled out per tool. */
function consequence(action: ActionItem): string {
  const tool = action.payload.tool ?? "";
  if (tool.includes("send_sandbox_alert"))
    return "Publishes this alert to the in-app demo feed only. No real SMS or broadcast is ever sent.";
  if (tool.includes("assign_population"))
    return "Records a simulated assignment of residents to this shelter and updates its occupancy.";
  if (tool.includes("assign_unit")) return "Marks this crew/bus as dispatched inside the simulation.";
  if (tool.includes("inject_event")) return "Changes the live simulated city state (same effect as the event firing).";
  return "Executes the tool call below inside the simulation. Nothing leaves this sandbox.";
}

/** Human-readable consequence outcome of executing this action. */
function consequenceExecuted(action: ActionItem): string {
  const tool = action.payload.tool ?? "";
  if (tool.includes("send_sandbox_alert"))
    return "SMS alert was successfully published to the simulated resident feed.";
  if (tool.includes("assign_population"))
    return "Residents were assigned to the shelter and shelter occupancy was updated.";
  if (tool.includes("assign_unit"))
    return "Crew/bus was successfully dispatched inside the simulation.";
  if (tool.includes("inject_event"))
    return "Simulated event was injected, modifying the live situation.";
  return "Executed successfully inside the simulation.";
}

export function Decisions() {
  const { actions, drafts, feed, approve, reject, queueDraft, report, reportLoading, loadReport, refreshDecisions, labels } =
    useStore();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void refreshDecisions();
  }, [refreshDecisions]);

  const queued = actions.filter((a) => a.status === "queued");
  const history = actions.filter((a) => a.status !== "queued").slice(0, 12);
  const smsDrafts = drafts.filter((d) => d.channel === "sms");
  const latestSms = smsDrafts[0];

  const act = async (fn: () => Promise<void>, id: string) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-0 overflow-y-auto lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.1fr)] lg:overflow-hidden">
      {/* Approval queue */}
      <section className="flex min-h-0 flex-col border-r border-edge">
        <header className="shrink-0 border-b border-edge bg-panel px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-[14px] font-bold">
            <Icon name="gavel" size={15} className="text-warn" />
            Waiting for you
            {queued.length > 0 && (
              <span className="rounded-full bg-warn px-2 text-[10.5px] font-bold text-ink">{queued.length}</span>
            )}
          </h2>
          <p className="mt-0.5 text-[11px] text-dim">
            Agents can't do anything consequential without you. Approve or reject each action.
          </p>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {queued.length === 0 && (
            <div className="rounded-xl border border-edge bg-panel p-5 text-center text-[12.5px] text-dim">
              Nothing waiting. Run an assessment and the agents will queue actions here.
            </div>
          )}
          {queued.map((a) => (
            <div key={a.id} className="anim-in rounded-xl border border-warn/30 bg-panel p-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded bg-warn/15 px-1.5 py-px text-[9px] font-bold uppercase text-warn">
                  Needs approval
                </span>
                <span className="text-[10px] text-dim">{new Date(a.created_at).toLocaleTimeString()}</span>
              </div>
              <p className="text-[13px] font-bold leading-snug">
                {labels.humanize(a.payload.title ?? (a.payload.tool ? toolLabel(a.payload.tool) : a.kind))}
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-mute">
                <span className="font-semibold text-text">If you approve:</span> {consequence(a)}
              </p>
              {a.matchedRules.length > 0 && (
                <p className="mt-1 text-[11px] leading-snug text-dim">
                  Why this needs you: {a.matchedRules.map((r) => r.reason).join("; ")}
                </p>
              )}
              {a.payload.tool && (
                <p className="mt-1.5 font-mono text-[10px] text-dim">
                  {a.payload.tool}({JSON.stringify(a.payload.args ?? {}).slice(0, 90)}…)
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy === a.id}
                  onClick={() => void act(() => approve(a.id), a.id)}
                  className="flex-1 rounded-lg bg-ok px-3 py-2 text-[12px] font-bold text-ink transition hover:brightness-110 disabled:opacity-50"
                >
                  {busy === a.id ? "Working…" : "Approve & execute"}
                </button>
                <button
                  disabled={busy === a.id}
                  onClick={() => void act(() => reject(a.id, "Rejected by operator"), a.id)}
                  className="rounded-lg border border-edge px-3 py-2 text-[12px] font-semibold text-mute transition hover:border-danger/50 hover:text-danger disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}

          {history.length > 0 && (
            <>
              <div className="pt-2 text-[10px] font-bold uppercase tracking-widest text-dim">Decision history</div>
              {history.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 rounded-lg border border-edge/60 bg-panel/60 px-3 py-2">
                  <StatusIcon status={a.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">
                      {labels.humanize(a.payload.title ?? (a.payload.tool ? toolLabel(a.payload.tool) : a.kind))}
                    </p>
                    <p className="text-[10px] text-dim">
                      {a.status}
                      {a.approved_by ? ` by ${a.approved_by}` : ""}
                      {a.blocked_reason ? ` — ${a.blocked_reason}` : ""}
                    </p>
                    {a.status === "executed" && (
                      <p className="mt-0.5 text-[10.5px] leading-snug text-ok font-medium">
                        ✓ {consequenceExecuted(a)}
                      </p>
                    )}
                    {a.status === "rejected" && (
                      <p className="mt-0.5 text-[10.5px] leading-snug text-danger font-medium">
                        ✗ Action was rejected and will not be executed.
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      {/* SMS preview */}
      <section className="flex min-h-0 flex-col border-r border-edge">
        <header className="shrink-0 border-b border-edge bg-panel px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-[14px] font-bold">
            <Icon name="phone" size={15} className="text-accent" />
            What residents would see
          </h2>
          <p className="mt-0.5 text-[11px] text-dim">Alerts publish to this sandbox feed only — never a real channel.</p>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-5">
          {/* Phone mockup */}
          <div className="w-64 shrink-0 rounded-[2rem] border-2 border-edge2 bg-ink p-3 shadow-2xl">
            <div className="mx-auto mb-3 h-1 w-16 rounded-full bg-edge2" />
            <div className="mb-2 text-center text-[10px] font-semibold text-dim">City Alerts</div>
            <div className="min-h-[260px] space-y-2 rounded-xl bg-panel p-2.5">
              {feed.length === 0 && !latestSms && (
                <p className="px-2 pt-16 text-center text-[11px] leading-relaxed text-dim">
                  No alerts yet. When you approve one, it appears here instantly.
                </p>
              )}
              {feed.map((f) => (
                <div key={f.id} className="anim-in rounded-lg rounded-tl-sm bg-accent/15 px-3 py-2">
                  <p className="text-[11px] leading-relaxed text-text">{labels.humanize(f.body)}</p>
                  <p className="mt-1 text-right text-[9px] text-dim">{labels.clock(f.published_at)}</p>
                </div>
              ))}
              {feed.length === 0 && latestSms && (
                <div className="rounded-lg rounded-tl-sm bg-panel2 px-3 py-2 opacity-70">
                  <p className="text-[9px] font-bold uppercase text-warn">Draft — awaiting your approval</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-mute">{labels.humanize(latestSms.body)}</p>
                </div>
              )}
            </div>
          </div>
          {drafts.length > 0 && (
            <div className="mt-4 w-full max-w-xs space-y-1.5">
              <div className="text-[10px] font-bold uppercase tracking-widest text-dim">All drafts</div>
              {drafts.slice(0, 5).map((d) => {
                const publishable =
                  d.validated &&
                  d.channel !== "internal" &&
                  !queued.some((a) => (a.payload.args as { draftId?: string } | undefined)?.draftId === d.draftId) &&
                  !history.some((a) => (a.payload.args as { draftId?: string } | undefined)?.draftId === d.draftId);
                return (
                  <div key={d.draftId} className="rounded-lg border border-edge bg-panel px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase text-accent">{d.channel}</span>
                      <span className="text-[10px] text-dim">{d.audience.replaceAll("_", " ")}</span>
                      {d.validated ? (
                        <Icon name="check" size={11} className="ml-auto text-ok" />
                      ) : (
                        <Icon name="alert" size={11} className="ml-auto text-warn" />
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-mute">{labels.humanize(d.body)}</p>
                    {publishable && (
                      <button
                        disabled={busy === d.draftId}
                        onClick={() => void act(() => queueDraft(d.draftId), d.draftId)}
                        className="mt-1.5 rounded-md bg-accent/15 px-2.5 py-1 text-[10.5px] font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50"
                      >
                        {busy === d.draftId ? "Queueing…" : "Queue for publication (needs your approval)"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Handoff report */}
      <section className="flex min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-edge bg-panel px-5 py-3.5">
          <div className="flex-1">
            <h2 className="flex items-center gap-2 text-[14px] font-bold">
              <Icon name="file" size={15} className="text-ok" />
              Handoff report
            </h2>
            <p className="mt-0.5 text-[11px] text-dim">The full brief for the next shift — every number traceable.</p>
          </div>
          {report ? (
            <button
              onClick={() => downloadMarkdown(report.markdown, report.reportId)}
              className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-[11.5px] font-semibold text-mute transition hover:border-edge2 hover:text-text"
            >
              <Icon name="download" size={12} />
              Download .md
            </button>
          ) : (
            <button
              onClick={() => void loadReport()}
              disabled={reportLoading}
              className="rounded-lg bg-ok px-3.5 py-1.5 text-[12px] font-bold text-ink transition hover:brightness-110 disabled:opacity-50"
            >
              {reportLoading ? "Generating…" : "Generate report"}
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto p-5">
          {report ? (
            <div
              className="report-md"
              dangerouslySetInnerHTML={{ __html: marked.parse(labels.humanize(report.markdown)) as string }}
            />
          ) : (
            <div className="rounded-xl border border-edge bg-panel p-5 text-[12.5px] leading-relaxed text-dim">
              After a run completes, generate the incident brief here. It's assembled from the database — findings,
              the debate, your approvals, and the audit trail — by the same tool the agents use.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "executed") return <Icon name="check" size={13} className="shrink-0 text-ok" />;
  if (status === "approved") return <Icon name="check" size={13} className="shrink-0 text-accent" />;
  if (status === "rejected") return <Icon name="x" size={13} className="shrink-0 text-danger" />;
  if (status === "blocked") return <Icon name="alert" size={13} className="shrink-0 text-danger" />;
  return <Icon name="clock" size={13} className="shrink-0 text-dim" />;
}

function downloadMarkdown(markdown: string, reportId: string) {
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `crisisgrid-${reportId}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
