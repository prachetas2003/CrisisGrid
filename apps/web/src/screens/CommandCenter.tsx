import { useState } from "react";
import { useStore } from "../store/store";
import { CityMap } from "../components/CityMap";
import { MapLegend } from "../components/MapLegend";
import { InspectorCard } from "../components/InspectorCard";
import { TimeScrubber } from "../components/TimeScrubber";
import { WhatIfPanel } from "../components/WhatIfPanel";
import { cityRisk, situationBullets, BAND_COLOR } from "../lib/derive";
import { Icon } from "../components/Icon";

const DEMO_CRISIS =
  "Storm knocked out power in Cedar Heights and Westbank, heavy rain is coming, and Riverbend General Hospital is on backup generators. What should we do?";

const DEMO_PROMPTS = [
  { label: "Default crisis", text: DEMO_CRISIS },
  {
    label: "Hospital fuel critical",
    text: "Riverbend General Hospital backup generators may fail within 4 hours. Power is still out in Cedar Heights and Westbank with heavy rain approaching. Prioritize hospital power and shelter options.",
  },
  {
    label: "Evacuation focus",
    text: "Power outage in Cedar Heights and Westbank, dark signals everywhere, heavy rain in 90 minutes. Find viable evacuation routes and shelter assignments for vulnerable residents.",
  },
  {
    label: "After bridge closure",
    text: "Main St Bridge is closed for inspection, power remains out in Cedar Heights and Westbank, and heavy rain is still coming. Reassess evacuation routes and public messaging.",
  },
] as const;

export function CommandCenter() {
  const {
    snapshot,
    running,
    startRun,
    startReplay,
    setScreen,
    runMode,
    agentsOnline,
    llmConfigured,
    whatifResult,
    resetScenario,
    whatifLoading,
  } = useStore();
  const [text, setText] = useState(DEMO_CRISIS);

  const risk = snapshot ? cityRisk(snapshot) : { score: 0, band: "low" as const };
  const bullets = snapshot ? situationBullets(snapshot) : [];
  const adoptedWhatIfs = (snapshot?.events.filter((e) => e.eventId.startsWith("WHATIF-")) ?? [])
    .map((e) => {
      const match = snapshot?.whatifs.whatifs.find((w) => w.id === e.eventId);
      return match ? match.title : e.eventId;
    });

  const run = () => {
    if (!text.trim() || running) return;
    startRun(text.trim());
    setScreen("agents");
  };

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Left rail */}
      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-b border-edge bg-panel p-4 sm:p-5 lg:h-full lg:w-[380px] lg:border-b-0 lg:border-r xl:w-[400px]">
        <div>
          <h1 className="text-[19px] font-extrabold leading-snug tracking-tight">
            Describe a city crisis.
            <br />
            <span className="text-accent">Nine AI agents</span> handle the rest.
          </h1>
          <p className="mt-2 text-[12.5px] leading-relaxed text-mute">
            They investigate with real tools, argue about the risks, and hand you an action plan where every number
            traces to evidence. You approve anything that matters.
          </p>
        </div>

        {/* Adopted what-if warning banner */}
        {adoptedWhatIfs.length > 0 && (
          <div className="anim-in rounded-xl border border-violet/30 bg-violet/5 p-3.5 text-[12px] leading-relaxed text-mute">
            <div className="flex items-center gap-1.5 font-bold text-violet mb-1">
              <Icon name="flask" size={13} className="text-violet" />
              Timeline modified by simulation
            </div>
            <p className="mb-2">
              The live timeline has been modified by the following simulation events:{" "}
              <span className="font-semibold text-text">{adoptedWhatIfs.join(", ")}</span>.
              This may block bridges, cause outages, or flood road corridors.
            </p>
            <button
              type="button"
              onClick={() => void resetScenario()}
              disabled={whatifLoading !== null}
              className="rounded bg-violet/20 hover:bg-violet/30 text-violet px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50"
            >
              {whatifLoading === "reset" ? "Resetting…" : "Reset to standard scenario"}
            </button>
          </div>
        )}

        {/* Incident input */}
        <div className="rounded-xl border border-edge bg-panel2 p-3.5">
          <label className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-dim">
            What's happening?
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-lg border border-edge bg-ink px-3 py-2.5 text-[13px] leading-relaxed text-text placeholder-dim outline-none transition focus:border-accent/60"
            placeholder="Describe the situation in plain English…"
          />
          <div className="mb-2 flex flex-wrap gap-1.5">
            {DEMO_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setText(p.text)}
                className={`rounded-md border px-2 py-1 text-[10.5px] font-medium transition ${
                  text === p.text
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-edge text-dim hover:border-edge2 hover:text-mute"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={run}
              disabled={running || !text.trim() || !agentsOnline || !llmConfigured}
              title={
                !agentsOnline
                  ? "Agent service is offline"
                  : !llmConfigured
                    ? "Gemini API key is not configured"
                    : "Run assessment"
              }
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-bold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="play" size={13} />
              {running ? "Agents are working…" : "Run live assessment"}
            </button>
            <button
              onClick={() => {
                startReplay();
                setScreen("agents");
              }}
              disabled={running}
              title="Play back a recorded real run — works even without the AI service or an API key"
              className="rounded-lg border border-edge px-3 py-2.5 text-[12px] font-semibold text-mute transition hover:border-edge2 hover:text-text disabled:opacity-40"
            >
              Watch a recorded run
            </button>
          </div>
          {!agentsOnline && (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-[11.5px] leading-relaxed text-mute animate-in">
              <div className="flex items-center gap-1.5 font-bold text-danger mb-1">
                <Icon name="alert" size={12} />
                Agent service offline
              </div>
              The agent backend is not running. Run <code className="bg-panel2 px-1 rounded font-mono text-[10px] text-accent">pnpm agents</code> in your terminal or click "Watch a recorded run".
            </div>
          )}
          {agentsOnline && !llmConfigured && (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-3 text-[11.5px] leading-relaxed text-mute animate-in">
              <div className="flex items-center gap-1.5 font-bold text-warn mb-1">
                <Icon name="alert" size={12} />
                Gemini API Key missing
              </div>
              Add <code className="bg-panel2 px-1 rounded font-mono text-[10px] text-accent">GOOGLE_API_KEY</code> to your <code className="bg-panel2 px-1 rounded font-mono text-[10px] text-accent">.env</code> file, or click "Watch a recorded run".
            </div>
          )}
          {running && runMode === "live" && (
            <p className="mt-2 text-[11px] text-dim">
              Streaming live — open the{" "}
              <button className="font-semibold text-accent underline" onClick={() => setScreen("agents")}>
                Agent Room
              </button>{" "}
              to watch.
            </p>
          )}
        </div>

        {/* Situation summary */}
        <div className="rounded-xl border border-edge bg-panel2 p-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-dim">
              {whatifResult ? "Preview situation" : "Current situation"}
            </span>
            <span
              className="rounded-full px-2.5 py-0.5 text-[11px] font-bold"
              style={{ background: `${BAND_COLOR[risk.band]}22`, color: BAND_COLOR[risk.band] }}
            >
              City risk {risk.score} / 100
            </span>
          </div>
          <ul className="space-y-2">
            {bullets.map((b) => (
              <li key={b.text} className="flex items-start gap-2 text-[12.5px] leading-snug">
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: b.tone === "danger" ? "#ef4444" : b.tone === "warn" ? "#fbbf24" : "#34d399" }}
                />
                <span className="text-mute">{b.text}</span>
              </li>
            ))}
            {bullets.length === 0 && <li className="text-[12px] text-dim">All quiet. Advance time to see the storm develop.</li>}
          </ul>
        </div>

        <WhatIfPanel />

        <p className="mt-auto pt-2 text-[10.5px] leading-relaxed text-dim">
          Simulated exercise on a fictional city (real Portland-area coordinates). Weather can go live via Open-Meteo.
          No real dispatch or public alerts are ever sent.
        </p>
      </aside>

      {/* Map */}
      <div className="relative min-h-[320px] min-w-0 flex-1 bg-ink lg:min-h-0">
        {whatifResult && (
          <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 rounded-lg border border-violet/40 bg-ink/90 px-3 py-2 shadow-lg backdrop-blur-sm">
            <p className="text-[11px] font-bold text-violet">What-if preview: {whatifResult.whatif.title}</p>
            <p className="text-[10.5px] text-dim">
              Purple zone outlines show affected neighborhoods. Apply to live situation to re-run agents against this
              world.
            </p>
          </div>
        )}
        <CityMap />
        <MapLegend />
        <InspectorCard />
        <TimeScrubber />
      </div>
    </div>
  );
}
