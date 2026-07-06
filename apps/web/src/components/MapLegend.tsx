export function MapLegend() {
  return (
    <div className="pointer-events-none absolute bottom-16 left-2 z-10 rounded-xl border border-edge bg-panel/90 px-3 py-2.5 backdrop-blur sm:bottom-4 sm:left-4 sm:px-4 sm:py-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-dim">Map key</div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[11px] text-mute">
        <LegendSwatch color="#ef4444" label="Danger zone" />
        <LegendSwatch color="#fb923c" label="High risk" />
        <LegendSwatch color="#fbbf24" label="Watch" />
        <LegendSwatch color="#34d399" label="OK" />
        <span className="flex items-center gap-2">
          <span className="inline-block h-0 w-4 border-t-2 border-dashed border-accent" />
          Flood-risk area
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-block h-1 w-4 rounded bg-ok" />
          Recommended route
        </span>
      </div>
      <div className="mt-2 border-t border-edge pt-1.5 text-[10px] text-dim">Click anything for details</div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color, opacity: 0.85 }} />
      {label}
    </span>
  );
}
