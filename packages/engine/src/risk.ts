import type {
  CorridorState,
  FacilityPowerState,
  OutageState,
  WeatherState,
  ZoneFeature,
} from "@crisisgrid/shared";
import type { ScenarioDataset } from "./loader.js";
import { distanceKm, polygonCentroid } from "./geo.js";

/**
 * Deterministic zone risk scoring — the single source of the risk score shown
 * in the UI and cited by the Commander (plan/05, geo.overlay_risk_layers).
 * Weighted factors, each normalized 0..1 (plan/07 §2):
 *   outage 0.25 · flood 0.25 · congestion 0.15 · vulnerability 0.15 ·
 *   critical facility exposure 0.15 · shelter distance 0.05
 */

export const RISK_WEIGHTS = {
  outage: 0.25,
  flood: 0.25,
  congestion: 0.15,
  vulnerability: 0.15,
  criticalFacility: 0.15,
  shelterDistance: 0.05,
} as const;

export type RiskFactors = Record<keyof typeof RISK_WEIGHTS, number>;

export interface ZoneRisk {
  zone: string;
  score0to100: number;
  band: "low" | "medium" | "high" | "critical";
  factors: RiskFactors;
}

export interface RiskOverlay {
  perZone: ZoneRisk[];
  cityScore: number;
}

export function band(score: number): ZoneRisk["band"] {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

interface StateView {
  outages: OutageState[];
  corridors: CorridorState[];
  facilityPower: FacilityPowerState[];
  weather: WeatherState[];
}

export function computeRiskOverlay(
  dataset: ScenarioDataset,
  state: StateView,
  currentTick: number,
): RiskOverlay {
  const zones = dataset.city.features.filter(
    (f): f is ZoneFeature => f.properties.kind === "zone",
  );
  const floodplains = dataset.city.features.filter((f) => f.properties.kind === "floodplain");
  const shelterFacilities = dataset.facilities.facilities.filter((f) => f.kind === "shelter");

  const perZone: ZoneRisk[] = zones.map((zf) => {
    const zoneId = zf.properties.zoneId;

    // --- outage factor ---
    let outage = 0;
    for (const o of state.outages) {
      if (o.status === "restored") continue;
      const hit = o.zones.find((z) => z.zone === zoneId);
      if (hit) outage = Math.max(outage, hit.level === "out" ? 1 : 0.5);
    }

    // --- flood factor: zone in an activating floodplain, scaled by proximity of rain ---
    let flood = 0;
    const weather = state.weather[0];
    if (weather) {
      const effectivePeak = weather.peakMmHr * weather.intensityFactor;
      for (const fp of floodplains) {
        const props = fp.properties as {
          zones: string[];
          activationThresholdMmHr: number;
        };
        if (!props.zones.includes(zoneId)) continue;
        if (effectivePeak >= props.activationThresholdMmHr) {
          // Proximity: 0 ticks away → 1.0, 30+ ticks away → 0.
          const ticksAway = Math.max(0, weather.rainArrivalTick - currentTick);
          const proximity = Math.min(1, 1 - ticksAway / 30);
          // Intensity margin above threshold scales the factor, so what-ifs
          // that intensify rain strictly raise flood risk.
          const intensity = 0.6 + 0.4 * Math.min(2, effectivePeak / props.activationThresholdMmHr);
          flood = Math.max(flood, Math.min(1, proximity * intensity));
        } else {
          flood = Math.max(flood, 0.2);
        }
      }
    }

    // --- congestion factor: mean effective level of corridors crossing the zone ---
    const zoneCorridors = dataset.network.corridors.filter((c) => c.zones.includes(zoneId));
    let congestion = 0;
    if (zoneCorridors.length > 0) {
      let sum = 0;
      for (const c of zoneCorridors) {
        const cs = state.corridors.find((s) => s.corridorId === c.id);
        sum += effectiveCongestion(cs);
      }
      congestion = sum / zoneCorridors.length;
    }

    // --- vulnerability factor (static per zone) ---
    const v = zf.properties.vulnerabilityIndex;
    const vulnerability = Math.min(
      1,
      (v.elderlyPct / 30 + v.medDevicePct / 6 + v.mobilityPct / 20) / 3,
    );

    // --- critical facility exposure: hospitals/water in zone without grid power ---
    let criticalFacility = 0;
    for (const f of dataset.facilities.facilities) {
      if (f.zone !== zoneId) continue;
      if (f.kind !== "hospital" && f.kind !== "water") continue;
      const ps = state.facilityPower.find((p) => p.facilityId === f.id);
      if (!ps || ps.powerStatus === "grid") continue;
      criticalFacility = Math.max(criticalFacility, ps.powerStatus === "out" ? 1 : 0.8);
    }

    // --- shelter distance: nearest shelter centroid distance, capped at 8km ---
    const centroid = polygonCentroid(zf.geometry.coordinates[0]!);
    let nearest = Infinity;
    for (const s of shelterFacilities) {
      nearest = Math.min(nearest, distanceKm(centroid, [s.lon, s.lat]));
    }
    const shelterDistance = Number.isFinite(nearest) ? Math.min(1, nearest / 8) : 1;

    const factors: RiskFactors = {
      outage,
      flood,
      congestion,
      vulnerability,
      criticalFacility,
      shelterDistance,
    };
    const score =
      100 *
      (Object.keys(RISK_WEIGHTS) as (keyof typeof RISK_WEIGHTS)[]).reduce(
        (acc, k) => acc + RISK_WEIGHTS[k] * factors[k],
        0,
      );
    const rounded = Math.round(score * 10) / 10;
    return { zone: zoneId, score0to100: rounded, band: band(rounded), factors };
  });

  // City score: max zone score blended with mean — a single critical zone must dominate.
  const max = Math.max(...perZone.map((z) => z.score0to100));
  const mean = perZone.reduce((a, z) => a + z.score0to100, 0) / perZone.length;
  const cityScore = Math.round((0.7 * max + 0.3 * mean) * 10) / 10;

  return { perZone, cityScore };
}

/** Dark signals add +0.15 congestion to their corridor (plan/07 §2). */
export function effectiveCongestion(cs: CorridorState | undefined): number {
  if (!cs) return 0;
  const signalPenalty = cs.signalStatus === "dark" ? 0.15 : cs.signalStatus === "flash" ? 0.05 : 0;
  return Math.min(1, cs.level + signalPenalty);
}
