import { useStore } from "../store/store";
import { Icon } from "./Icon";

/** Timeline scrubber — "5:20 PM → now" in city time; ticks never shown. */
export function TimeScrubber() {
  const { snapshot, labels, viewTick, setViewTick, advance } = useStore();
  if (!snapshot) return null;

  const max = snapshot.currentTick;
  const value = viewTick ?? max;
  const viewingPast = viewTick !== null && viewTick < max;

  return (
    <div className="pointer-events-auto absolute bottom-2 left-1/2 z-10 flex w-[min(440px,calc(100%-1rem))] -translate-x-1/2 items-center gap-2 rounded-xl border border-edge bg-panel/90 px-3 py-2 backdrop-blur sm:bottom-4 sm:gap-3 sm:px-4 sm:py-2.5">
      <Icon name="clock" size={14} className="shrink-0 text-dim" />
      <span className="w-16 shrink-0 text-[11px] font-semibold text-mute">{labels.time(value)}</span>
      <input
        type="range"
        min={0}
        max={max}
        value={value}
        onChange={(e) => {
          const t = Number(e.target.value);
          setViewTick(t >= max ? null : t);
        }}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-edge accent-sky-400"
      />
      {viewingPast ? (
        <button
          onClick={() => setViewTick(null)}
          className="shrink-0 rounded-md bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-accent/25"
        >
          Back to now
        </button>
      ) : (
        <button
          onClick={() => void advance(3)}
          title="Advance the simulated storm by 15 minutes"
          className="shrink-0 rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-mute transition hover:border-edge2 hover:text-text"
        >
          +15 min
        </button>
      )}
    </div>
  );
}
