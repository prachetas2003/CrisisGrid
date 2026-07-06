import { useStore } from "../store/store";
import { BAND_COLOR, type RiskBand } from "../lib/derive";
import { Icon } from "./Icon";

/**
 * What-if simulations — runs a REAL backend fork of the scenario engine
 * (POST /api/scenario/fork) and diffs the computed risk before vs after.
 * Never touches the live timeline until the operator explicitly adopts.
 */
export function WhatIfPanel() {
  const { snapshot, labels, runWhatIf, adoptWhatIf, resetScenario, whatifLoading, whatifResult, clearWhatIf } = useStore();
  if (!snapshot) return null;
  const whatifs = snapshot.whatifs?.whatifs ?? [];
  if (!whatifs.length) return null;

  return (
    <div className="rounded-xl border border-edge bg-panel2 p-3.5">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon name="flask" size={13} className="text-violet" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-dim">What-if simulations</span>
      </div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-snug text-dim">
          Preview a change on the map (purple overlay). Apply to live, then re-run assessment.
        </p>
        <button
          type="button"
          onClick={() => void resetScenario()}
          disabled={whatifLoading !== null}
          className="shrink-0 rounded-md border border-edge px-2 py-1 text-[10px] font-semibold text-dim transition hover:border-edge2 hover:text-mute disabled:opacity-50"
          title="Restore the original scenario state (clears applied what-ifs)"
        >
          {whatifLoading === "reset" ? "Resetting…" : "Reset scenario"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {whatifs.map((w) => (
          <button
            key={w.id}
            onClick={() => void runWhatIf(w)}
            disabled={whatifLoading !== null}
            className={`rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium transition disabled:opacity-50 ${
              whatifResult?.whatif.id === w.id
                ? "border-violet/60 bg-violet/10 text-violet"
                : "border-edge text-mute hover:border-edge2 hover:text-text"
            }`}
          >
            {whatifLoading === w.id ? "Simulating…" : w.title}
          </button>
        ))}
      </div>

      {whatifResult && (
        <div className="anim-in mt-3 rounded-lg border border-violet/30 bg-ink p-3">
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <div className="text-[12px] font-bold text-violet">{whatifResult.whatif.title}</div>
            <button onClick={clearWhatIf} className="text-dim hover:text-text" title="Dismiss preview">
              <Icon name="x" size={12} />
            </button>
          </div>
          <p className="mb-2 text-[11px] leading-snug text-dim">{labels.humanize(whatifResult.whatif.description)}</p>
          <p className="mb-2 text-[10.5px] font-semibold text-violet">
            Preview active — check the map for purple zone outlines
            {whatifResult.affectedZones.length > 0 &&
              ` (${whatifResult.affectedZones.map((z) => labels.zone(z)).join(", ")})`}
          </p>
          <div className="mb-2 flex items-center gap-2 text-[12px]">
            <span className="text-dim">City risk:</span>
            <span className="font-bold text-mute">{Math.round(whatifResult.cityBefore)}</span>
            <Icon name="arrowRight" size={11} className="text-dim" />
            <span
              className="font-bold"
              style={{ color: whatifResult.cityAfter > whatifResult.cityBefore ? "#ef4444" : "#34d399" }}
            >
              {Math.round(whatifResult.cityAfter)}
            </span>
            <span className="text-[10px] text-dim">/ 100</span>
          </div>
          {whatifResult.riskDelta.slice(0, 4).map((d) => (
            <div key={d.zone} className="flex items-center justify-between py-0.5 text-[11.5px]">
              <span className="text-mute">{labels.zone(d.zone)}</span>
              <span className="flex items-center gap-1.5 font-mono text-[11px]">
                <span style={{ color: BAND_COLOR[d.beforeBand as RiskBand] ?? "#8da2bd" }}>{Math.round(d.before)}</span>
                <Icon name="arrowRight" size={9} className="text-dim" />
                <span style={{ color: BAND_COLOR[d.afterBand as RiskBand] ?? "#8da2bd" }}>{Math.round(d.after)}</span>
              </span>
            </div>
          ))}
          {whatifResult.riskDelta.length === 0 && (
            <p className="text-[11px] text-dim">
              Risk scores barely moved — look for route color changes (red = avoid) or facility status updates on the
              map.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2 border-t border-edge pt-2.5">
            <button
              onClick={() => void adoptWhatIf()}
              disabled={whatifLoading !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet px-3 py-2 text-[11.5px] font-bold text-ink transition hover:brightness-110 disabled:opacity-50"
            >
              <Icon name="check" size={12} />
              Apply to live situation
            </button>
            <button
              onClick={clearWhatIf}
              className="rounded-lg border border-edge px-3 py-2 text-[11.5px] font-semibold text-mute transition hover:border-edge2 hover:text-text"
            >
              Dismiss preview
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-snug text-dim">
            After applying, edit the crisis text if needed and run a new live assessment — agents will read the updated
            world state.
          </p>
        </div>
      )}
    </div>
  );

}
