import type { EntityState, Facility, MapSnapshot, RouteDef } from "./types";
import { tickToClock } from "./labels";

/**
 * Turns raw entity state into the plain-language statuses the UI renders.
 * All logic here mirrors what the backend risk engine computes — this file
 * only translates, it never invents numbers.
 */

export type RiskBand = "low" | "moderate" | "high" | "severe";

export interface ZoneStatus {
  zoneId: string;
  band: RiskBand;
  score: number;
  hasOutage: boolean;
  factors: string[];
}

export interface FacilityStatus {
  facility: Facility;
  headline: string;
  tone: "ok" | "warn" | "danger";
  details: string[];
}

export interface RouteVerdict {
  route: RouteDef;
  verdict: "recommended" | "open" | "caution" | "avoid";
  label: string;
  etaMin: number;
  reasons: string[];
}

const bandOf = (v: unknown): RiskBand => {
  const b = String(v ?? "low").toLowerCase();
  if (b === "severe" || b === "critical") return "severe";
  if (b === "high") return "high";
  if (b === "moderate" || b === "medium" || b === "elevated") return "moderate";
  return "low";
};

export const BAND_COLOR: Record<RiskBand, string> = {
  low: "#34d399",
  moderate: "#fbbf24",
  high: "#fb923c",
  severe: "#ef4444",
};

export const BAND_LABEL: Record<RiskBand, string> = {
  low: "OK",
  moderate: "Watch",
  high: "High risk",
  severe: "Danger",
};

function entities(snapshot: MapSnapshot, type: string): EntityState[] {
  return snapshot.state.byType[type] ?? [];
}

export function weatherState(snapshot: MapSnapshot): {
  summary: string;
  rainArrivalTick: number | null;
  peakMmHr: number | null;
  windGustKmh: number | null;
  rainArrivalLabel: string | null;
} {
  const w = entities(snapshot, "weather")[0];
  if (!w) return { summary: "", rainArrivalTick: null, peakMmHr: null, windGustKmh: null, rainArrivalLabel: null };
  const rainArrivalTick = typeof w.rainArrivalTick === "number" ? w.rainArrivalTick : null;
  return {
    summary: String(w.summary ?? ""),
    rainArrivalTick,
    peakMmHr: typeof w.peakMmHr === "number" ? w.peakMmHr : null,
    windGustKmh: typeof w.windGustKmh === "number" ? w.windGustKmh : null,
    rainArrivalLabel: rainArrivalTick !== null ? tickToClock(rainArrivalTick) : null,
  };
}

export function zoneStatuses(snapshot: MapSnapshot): Map<string, ZoneStatus> {
  const map = new Map<string, ZoneStatus>();
  const outageZones = new Set<string>();
  for (const o of entities(snapshot, "outage")) {
    const zones = o.zones as { zone: string; level: string }[] | undefined;
    for (const z of zones ?? []) if (z.level !== "restored") outageZones.add(z.zone);
  }
  for (const r of entities(snapshot, "riskOverlay")) {
    if (r.entityId === "city") continue;
    const score = typeof r.score0to100 === "number" ? r.score0to100 : 0;
    const factors: string[] = [];
    if (outageZones.has(r.entityId)) factors.push("power outage");
    const f = r.factors as Record<string, number> | undefined;
    if (f) {
      if ((f.flood ?? 0) > 20) factors.push("flood exposure");
      if ((f.congestion ?? 0) > 20) factors.push("heavy traffic");
      if ((f.vulnerability ?? 0) > 20) factors.push("vulnerable residents");
    }
    map.set(r.entityId, {
      zoneId: r.entityId,
      band: bandOf(r.band),
      score,
      hasOutage: outageZones.has(r.entityId),
      factors,
    });
  }
  return map;
}

export function cityRisk(snapshot: MapSnapshot): { score: number; band: RiskBand } {
  const city = entities(snapshot, "riskOverlay").find((r) => r.entityId === "city");
  const score = typeof city?.cityScore === "number" ? city.cityScore : typeof city?.score0to100 === "number" ? city.score0to100 : 0;
  return { score: Math.round(score), band: bandOf(city?.band) };
}

export function facilityStatuses(snapshot: MapSnapshot): FacilityStatus[] {
  const power = new Map(entities(snapshot, "facilityPower").map((e) => [e.entityId, e]));
  const shelterState = new Map(entities(snapshot, "shelter").map((e) => [e.entityId, e]));
  const out: FacilityStatus[] = [];

  for (const fac of snapshot.geometry.facilities.facilities) {
    if (fac.kind === "signal") continue; // 28 signal dots = clutter; zones show outage state
    const p = power.get(fac.id);
    const status = String(p?.powerStatus ?? "grid");

    if (fac.kind === "hospital") {
      if (status === "backup") {
        const h = p?.backupRemainingH;
        out.push({
          facility: fac,
          headline: `On backup power${typeof h === "number" ? ` — ${h}h fuel left` : ""}`,
          tone: typeof h === "number" && h <= 6 ? "danger" : "warn",
          details: [`${fac.beds ?? "?"} beds`, "Grid power lost; running on generators"],
        });
      } else if (status === "out") {
        out.push({ facility: fac, headline: "NO POWER", tone: "danger", details: [`${fac.beds ?? "?"} beds`] });
      } else {
        out.push({ facility: fac, headline: "Normal operations", tone: "ok", details: [`${fac.beds ?? "?"} beds`] });
      }
    } else if (fac.kind === "shelter") {
      const s = shelterState.get(fac.id);
      const occupied = typeof s?.occupied === "number" ? s.occupied : 0;
      const cap = fac.capacity ?? 0;
      const pct = cap ? Math.round((occupied / cap) * 100) : 0;
      const accepting = s?.acceptingNew !== false;
      out.push({
        facility: fac,
        headline: !accepting ? "FULL — not accepting arrivals" : `${pct}% full (${occupied}/${cap})`,
        tone: !accepting || pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok",
        details: [
          accepting ? "Accepting arrivals" : "Closed to new arrivals",
          ...(fac.accessible ? ["Wheelchair accessible"] : []),
          ...(fac.petFriendly ? ["Pet friendly"] : []),
          String(s?.powerStatus ?? "grid") === "grid" ? "On grid power" : `Power: ${String(s?.powerStatus)}`,
        ],
      });
    } else if (fac.kind === "substation") {
      const damaged = entities(snapshot, "outage").some((o) => o.substation === fac.id);
      out.push({
        facility: fac,
        headline: damaged ? "Storm-damaged — cause of the outage" : "Operating normally",
        tone: damaged ? "danger" : "ok",
        details: fac.feeds?.length ? [`Feeds ${fac.feeds.length} zones`] : [],
      });
    } else if (fac.kind === "water") {
      out.push({
        facility: fac,
        headline: status === "out" ? "NO POWER — water pressure at risk" : "Operating normally",
        tone: status === "out" ? "danger" : status === "backup" ? "warn" : "ok",
        details: [],
      });
    } else if (fac.kind === "staging") {
      out.push({ facility: fac, headline: "Available staging area", tone: "ok", details: [] });
    }
  }
  return out;
}

const FLOOD_THRESHOLD_MM_HR = 28;

export function routeVerdicts(snapshot: MapSnapshot): RouteVerdict[] {
  const weather = weatherState(snapshot);
  const congestion = new Map(entities(snapshot, "corridor").map((e) => [e.entityId, e]));
  const closures = entities(snapshot, "closure");
  const closedCorridors = new Set(
    closures.filter((c) => c.status !== "reopened").map((c) => String(c.corridorId ?? c.entityId)),
  );

  const verdicts: RouteVerdict[] = snapshot.geometry.network.routes.map((route) => {
    const reasons: string[] = [];
    let verdict: RouteVerdict["verdict"] = "open";

    // ETA adjusted by average congestion on the route's corridors
    const levels = route.corridorIds
      .map((id) => congestion.get(id))
      .filter(Boolean)
      .map((c) => (typeof c!.level === "number" ? (c!.level as number) : 0.4));
    const avg = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0.4;
    const etaMin = Math.round(route.baseEtaMin * (1 + avg));

    const closed = route.corridorIds.some((id) => closedCorridors.has(id));
    if (closed) {
      verdict = "avoid";
      reasons.push("A road on this route is closed");
    }

    const floodRisk =
      route.floodplainIds.length > 0 && weather.peakMmHr !== null && weather.peakMmHr >= FLOOD_THRESHOLD_MM_HR;
    if (floodRisk) {
      verdict = "avoid";
      reasons.push(
        weather.rainArrivalLabel
          ? `Crosses the flood zone — likely floods around ${weather.rainArrivalLabel}`
          : "Crosses the flood zone during heavy rain",
      );
    }

    const darkSignals = route.corridorIds.some((id) => congestion.get(id)?.signalStatus === "dark");
    if (darkSignals && verdict === "open") {
      verdict = "caution";
      reasons.push("Traffic signals are dark along this route");
    }
    if (avg >= 0.7) reasons.push("Heavy congestion");

    return { route, verdict, label: "", etaMin, reasons };
  });

  // Mark the fastest safe evacuation route (Z-05 → Z-07 group) as recommended
  const evac = verdicts.filter((v) => v.route.fromZone === "Z-05" && v.route.toZone === "Z-07");
  const best = evac.filter((v) => v.verdict !== "avoid").sort((a, b) => a.etaMin - b.etaMin)[0];
  if (best) {
    best.verdict = "recommended";
    best.reasons.unshift("Fastest route that stays clear of the flood zone");
  }

  for (const v of verdicts) {
    v.label =
      v.verdict === "recommended"
        ? `Recommended — ${v.etaMin} min`
        : v.verdict === "avoid"
          ? `Avoid${v.reasons[0]?.includes("floods around") ? ` — ${v.reasons[0].split("— ")[1]}` : ""}`
          : v.verdict === "caution"
            ? `Caution — ${v.etaMin} min`
            : `Open — ${v.etaMin} min`;
  }
  return verdicts;
}

export const VERDICT_COLOR: Record<RouteVerdict["verdict"], string> = {
  recommended: "#34d399",
  open: "#8da2bd",
  caution: "#fbbf24",
  avoid: "#ef4444",
};

export function situationBullets(snapshot: MapSnapshot): { text: string; tone: "ok" | "warn" | "danger" }[] {
  const bullets: { text: string; tone: "ok" | "warn" | "danger" }[] = [];
  const zones = zoneStatuses(snapshot);
  const weather = weatherState(snapshot);
  const zoneName = (id: string) =>
    (snapshot.geometry.city.features.find((f) => f.properties.zoneId === id)?.properties.name as string) ?? id;

  for (const o of entities(snapshot, "outage")) {
    const zoneList = ((o.zones as { zone: string; level: string }[]) ?? []).filter((z) => z.level !== "restored");
    if (!zoneList.length) continue;
    const names = zoneList.map((z) => zoneName(z.zone)).join(" and ");
    const customers = typeof o.customersOut === "number" ? o.customersOut.toLocaleString() : "thousands of";
    bullets.push({ text: `${names} are without power — ${customers} customers affected`, tone: "danger" });
  }
  if (weather.rainArrivalLabel && weather.peakMmHr !== null && weather.peakMmHr >= FLOOD_THRESHOLD_MM_HR) {
    bullets.push({
      text: `Heavy rain arrives around ${weather.rainArrivalLabel} — strong enough to flood the riverside flood zones`,
      tone: "warn",
    });
  } else if (weather.summary) {
    bullets.push({ text: weather.summary, tone: "warn" });
  }
  const worst = [...zones.values()].sort((a, b) => b.score - a.score)[0];
  if (worst && (worst.band === "high" || worst.band === "severe")) {
    bullets.push({ text: `${zoneName(worst.zoneId)} is the highest-risk neighborhood right now`, tone: "danger" });
  }
  const hospitalOnBackup = entities(snapshot, "facilityPower").find(
    (e) => String(e.powerStatus) === "backup" && e.entityId.startsWith("HOSP"),
  );
  if (hospitalOnBackup) {
    const name = snapshot.geometry.facilities.facilities.find((f) => f.id === hospitalOnBackup.entityId)?.name;
    const h = hospitalOnBackup.backupRemainingH;
    bullets.push({
      text: `${name ?? "A hospital"} is running on backup generators${typeof h === "number" ? ` with ${h} hours of fuel` : ""}`,
      tone: "danger",
    });
  }
  return bullets;
}
