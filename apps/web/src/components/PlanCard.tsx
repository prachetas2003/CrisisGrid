import type { Plan } from "../lib/types";
import { Icon } from "./Icon";

const TIER_CHIP: Record<string, { label: string; cls: string }> = {
  safe: { label: "auto-safe", cls: "bg-ok/15 text-ok" },
  needs_approval: { label: "needs your approval", cls: "bg-warn/15 text-warn" },
  blocked: { label: "blocked by policy", cls: "bg-danger/15 text-danger" },
};

const WINDOW_LABEL: Record<string, string> = {
  immediate: "Do now",
  short_term: "Next 1–2 hours",
  next_period: "Later tonight",
};

export function PlanCard({
  plan,
  humanize,
  onGoToDecisions,
}: {
  plan: Plan;
  humanize: (s: string) => string;
  onGoToDecisions?: () => void;
}) {
  const approvals = plan.actions.filter((a) => a.tier === "needs_approval").length;
  const byWindow: Record<string, Plan["actions"]> = { immediate: [], short_term: [], next_period: [] };
  for (const a of plan.actions) (byWindow[a.timeWindow] ??= []).push(a);

  return (
    <div className="anim-in rounded-xl border border-violet/40 bg-panel p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="shield" size={15} className="text-violet" />
        <span className="text-[13px] font-bold text-violet">The plan (revision {plan.revision})</span>
        <span className="ml-auto rounded-full bg-panel2 px-2.5 py-0.5 text-[10.5px] font-bold text-mute">
          Risk {Math.round(plan.riskScore)} / 100 · {Math.round(plan.confidence * 100)}% confidence
        </span>
      </div>
      <p className="mb-3 text-[12.5px] leading-relaxed text-mute">{humanize(plan.situationSummary)}</p>

      {plan.objectives.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-dim">Objectives</div>
          {plan.objectives.map((o) => (
            <p key={o} className="text-[12px] leading-snug text-mute">
              • {humanize(o)}
            </p>
          ))}
        </div>
      )}

      {(["immediate", "short_term", "next_period"] as const).map((win) =>
        byWindow[win] && byWindow[win]!.length > 0 ? (
          <div key={win} className="mb-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-dim">{WINDOW_LABEL[win]}</div>
            <div className="space-y-1.5">
              {byWindow[win]!.map((a) => {
                const chip = TIER_CHIP[a.tier] ?? TIER_CHIP.safe!;
                return (
                  <div key={a.id} className="rounded-lg bg-ink/60 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{humanize(a.title)}</span>
                      <span className={`shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase ${chip.cls}`}>
                        {chip.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-dim">{humanize(a.description)}</p>
                    <p className="mt-0.5 text-[10px] text-dim">→ {a.targetTeam.replaceAll("_", " ")}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null,
      )}

      {plan.unresolvedRisks.length > 0 && (
        <div className="mb-2 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2">
          <div className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-warn">Still worried about</div>
          {plan.unresolvedRisks.map((r) => (
            <p key={r} className="text-[11.5px] leading-snug text-mute">
              • {humanize(r)}
            </p>
          ))}
        </div>
      )}

      {approvals > 0 && onGoToDecisions && (
        <button
          onClick={onGoToDecisions}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-warn px-4 py-2.5 text-[12.5px] font-bold text-ink transition hover:brightness-110"
        >
          <Icon name="gavel" size={14} />
          {approvals} action{approvals === 1 ? "" : "s"} waiting for your approval →
        </button>
      )}
    </div>
  );
}
