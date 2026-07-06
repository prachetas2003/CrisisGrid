import { useStore } from "../store/store";
import {
  BAND_COLOR,
  BAND_LABEL,
  VERDICT_COLOR,
  facilityStatuses,
  routeVerdicts,
  zoneStatuses,
} from "../lib/derive";
import { Icon } from "./Icon";

/** Plain-language details for whatever the user clicked on the map. */
export function InspectorCard() {
  const { selected, select, snapshot, labels, findings } = useStore();
  if (!selected || !snapshot) return null;

  let body: React.ReactNode = null;
  let title = "";
  let subtitle = "";
  let accent = "#8da2bd";

  if (selected.kind === "zone") {
    const st = zoneStatuses(snapshot).get(selected.id);
    const feature = snapshot.geometry.city.features.find((f) => f.properties.zoneId === selected.id);
    const props = feature?.properties as Record<string, unknown> | undefined;
    title = labels.zone(selected.id);
    subtitle = "Neighborhood";
    accent = st ? BAND_COLOR[st.band] : accent;
    const population = typeof props?.population === "number" ? props.population.toLocaleString() : null;
    const related = findings.filter((f) => f.affectedZones.includes(selected.id)).slice(0, 3);
    body = (
      <>
        {st && (
          <div className="mb-3 flex items-center gap-2">
            <span
              className="rounded-full px-2.5 py-0.5 text-[11px] font-bold"
              style={{ background: `${BAND_COLOR[st.band]}22`, color: BAND_COLOR[st.band] }}
            >
              {BAND_LABEL[st.band]}
            </span>
            <span className="text-[11px] text-dim">Risk score {Math.round(st.score)} / 100</span>
          </div>
        )}
        <dl className="space-y-1.5 text-[12px]">
          {population && <Fact label="Residents" value={population} />}
          {st?.hasOutage && <Fact label="Power" value="OUT — part of the west-side outage" tone="danger" />}
          {st && st.factors.length > 0 && <Fact label="Risk drivers" value={st.factors.join(", ")} />}
        </dl>
        {related.length > 0 && (
          <div className="mt-3 border-t border-edge pt-2">
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-dim">What agents found here</div>
            {related.map((f) => (
              <p key={f.id} className="mb-1 text-[11.5px] leading-snug text-mute">
                • {labels.humanize(f.finding)}
              </p>
            ))}
          </div>
        )}
      </>
    );
  } else if (selected.kind === "facility") {
    const st = facilityStatuses(snapshot).find((s) => s.facility.id === selected.id);
    if (!st) return null;
    title = st.facility.name;
    subtitle = { hospital: "Hospital", shelter: "Shelter", substation: "Power substation", water: "Water facility", staging: "Staging area", school: "School", signal: "Signal" }[st.facility.kind] ?? "Facility";
    accent = { ok: "#34d399", warn: "#fbbf24", danger: "#ef4444" }[st.tone];
    body = (
      <>
        <p className="mb-2 text-[13px] font-semibold" style={{ color: accent }}>
          {st.headline}
        </p>
        <ul className="space-y-1 text-[12px] text-mute">
          {st.details.map((d) => (
            <li key={d}>• {d}</li>
          ))}
          <li className="text-dim">In {labels.zone(st.facility.zone)}</li>
        </ul>
      </>
    );
  } else if (selected.kind === "route") {
    const v = routeVerdicts(snapshot).find((r) => r.route.id === selected.id);
    if (!v) return null;
    title = labels.routeShort(selected.id);
    subtitle = `${labels.zone(v.route.fromZone)} → ${labels.zone(v.route.toZone)}`;
    accent = VERDICT_COLOR[v.verdict];
    body = (
      <>
        <p className="mb-2 text-[13px] font-semibold" style={{ color: accent }}>
          {v.label}
        </p>
        <ul className="space-y-1 text-[12px] text-mute">
          {v.reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
          <li className="text-dim">
            {v.route.distanceKm} km · normally {v.route.baseEtaMin} min
          </li>
        </ul>
      </>
    );
  }

  return (
    <div className="anim-in absolute right-4 top-4 z-10 w-72 rounded-xl border border-edge bg-panel/95 p-4 shadow-2xl backdrop-blur">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-dim">{subtitle}</div>
          <h3 className="text-[15px] font-bold leading-tight">{title}</h3>
        </div>
        <button onClick={() => select(null)} className="rounded-md p-1 text-dim transition hover:bg-panel2 hover:text-text">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div
        className="mb-3 h-0.5 w-10 rounded-full"
        style={{ background: accent }}
      />
      {body}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-dim">{label}</dt>
      <dd className={tone === "danger" ? "font-semibold text-danger" : "text-mute"}>{value}</dd>
    </div>
  );
}
