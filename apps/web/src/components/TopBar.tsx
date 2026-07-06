import { useStore, type Screen } from "../store/store";
import { Icon } from "./Icon";

const TABS: { id: Screen; label: string; icon: string }[] = [
  { id: "command", label: "Command Center", icon: "layers" },
  { id: "agents", label: "Agent Room", icon: "bot" },
  { id: "decisions", label: "Your Decisions", icon: "gavel" },
];

export function TopBar() {
  const {
    screen,
    setScreen,
    setJudgeOpen,
    running,
    runMode,
    actions,
    snapshot,
    labels,
    replayPaused,
    replaySpeed,
    toggleReplayPause,
    skipReplay,
    setReplaySpeed,
  } = useStore();
  const pendingCount = actions.filter((a) => a.status === "queued").length;

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-edge bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15">
          <Icon name="shield" size={17} color="#38bdf8" />
        </div>
        <div>
          <div className="text-sm font-bold leading-tight tracking-wide">CrisisGrid</div>
          <div className="text-[10px] leading-tight text-dim">AI Crisis Command Center</div>
        </div>
      </div>

      <nav className="ml-4 flex items-center gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setScreen(tab.id)}
            className={`relative flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition ${
              screen === tab.id ? "bg-panel2 text-text" : "text-mute hover:bg-panel2/60 hover:text-text"
            }`}
          >
            <Icon name={tab.icon} size={14} />
            {tab.label}
            {tab.id === "agents" && running && (
              <span className="pulse-dot ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-ok" />
            )}
            {tab.id === "decisions" && pendingCount > 0 && (
              <span className="ml-0.5 rounded-full bg-warn px-1.5 text-[10px] font-bold text-ink">{pendingCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        {runMode === "replay" && (
          <div className="flex items-center gap-2 rounded-full border border-violet/40 bg-violet/10 px-3 py-1 text-[11px] font-semibold text-violet">
            <span className="flex items-center gap-1">
              <Icon name="play" size={11} className={!replayPaused && running ? "pulse-dot" : ""} />
              {running ? "Replaying run" : "Replay finished"}
            </span>
            {running && (
              <>
                <div className="h-3 w-px bg-violet/30" />
                <button
                  onClick={() => toggleReplayPause()}
                  title={replayPaused ? "Resume Replay" : "Pause Replay"}
                  className="rounded p-0.5 hover:bg-violet/20 transition cursor-pointer"
                >
                  <Icon name={replayPaused ? "play" : "pause"} size={11} />
                </button>
                <button
                  onClick={() => skipReplay()}
                  title="Skip to End"
                  className="rounded p-0.5 hover:bg-violet/20 transition cursor-pointer"
                >
                  <Icon name="arrowRight" size={11} />
                </button>
                <div className="h-3 w-px bg-violet/30" />
                <button
                  onClick={() => setReplaySpeed(replaySpeed === 1 ? 2 : replaySpeed === 2 ? 4 : 1)}
                  title="Cycle Replay Speed"
                  className="rounded px-1.5 py-0.5 hover:bg-violet/20 font-mono text-[9px] leading-none transition cursor-pointer"
                >
                  {replaySpeed}x
                </button>
              </>
            )}
          </div>
        )}
        {runMode === "live" && running && (
          <span className="flex items-center gap-1.5 rounded-full border border-ok/40 bg-ok/10 px-3 py-1 text-[11px] font-semibold text-ok">
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-ok" />
            Agents working live
          </span>
        )}
        {snapshot && (
          <span className="flex items-center gap-1.5 text-[10px] text-dim sm:text-[11px]">
            <Icon name="clock" size={12} />
            <span className="hidden sm:inline">Sim time:</span>
            <span className="font-semibold text-mute">{labels.clock(snapshot.simTime)}</span>
          </span>
        )}
        <button
          onClick={() => setJudgeOpen(true)}
          className="rounded-lg border border-edge bg-panel2 px-3 py-1.5 text-[12px] font-semibold text-mute transition hover:border-edge2 hover:text-text"
        >
          Judge Mode
        </button>
      </div>
    </header>
  );
}
