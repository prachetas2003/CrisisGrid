import type { FacilityPowerState, OutageState } from "@crisisgrid/shared";
import type { ScenarioDataset } from "./loader.js";

/**
 * Deterministic restoration priority ranking (plan/05, grid.estimate_restoration_priority).
 * Ordering policy: life-safety (hospitals, water) > signalized corridors > customer count.
 * Unit-tested by eval 4: the hospital circuit must rank #1 on the seeded scenario.
 */

export interface RestorationRank {
  circuitId: string;
  reason: string;
  estCrewHours: number;
  facilities: string[];
  priorityScore: number;
}

export function estimateRestorationPriority(
  dataset: ScenarioDataset,
  outage: OutageState,
  facilityPower: FacilityPowerState[],
): RestorationRank[] {
  const affectedZones = new Set(outage.zones.map((z) => z.zone));

  // A "circuit" in the demo model = one affected zone's feeder segment.
  const ranks: RestorationRank[] = [...affectedZones].map((zone) => {
    const zoneFacilities = dataset.facilities.facilities.filter((f) => f.zone === zone);
    const hospitals = zoneFacilities.filter((f) => f.kind === "hospital");
    const water = zoneFacilities.filter((f) => f.kind === "water");
    const signals = zoneFacilities.filter((f) => f.kind === "signal");
    const shelters = zoneFacilities.filter((f) => f.kind === "shelter");

    // Hospitals on failing/finite backup power raise urgency further.
    let hospitalUrgency = 0;
    for (const h of hospitals) {
      const ps = facilityPower.find((p) => p.facilityId === h.id);
      if (ps?.powerStatus === "out") hospitalUrgency = Math.max(hospitalUrgency, 2);
      else if (ps?.powerStatus === "backup") {
        const remaining = ps.backupRemainingH ?? 999;
        hospitalUrgency = Math.max(hospitalUrgency, remaining <= 8 ? 1.5 : 1);
      } else if (hospitals.length > 0) hospitalUrgency = Math.max(hospitalUrgency, 0.5);
    }

    const zoneFeature = dataset.city.features.find(
      (f) => f.properties.kind === "zone" && (f.properties as { zoneId: string }).zoneId === zone,
    );
    const population = zoneFeature
      ? (zoneFeature.properties as { population: number }).population
      : 0;

    const priorityScore =
      hospitalUrgency * 1000 +
      water.length * 500 +
      signals.length * 50 +
      shelters.length * 40 +
      population / 10000;

    const reasons: string[] = [];
    if (hospitals.length > 0)
      reasons.push(`life-safety: ${hospitals.map((h) => h.name).join(", ")}`);
    if (water.length > 0) reasons.push(`water system: ${water.map((w) => w.name).join(", ")}`);
    if (signals.length > 0) reasons.push(`${signals.length} signalized intersections dark`);
    if (shelters.length > 0) reasons.push(`${shelters.length} shelters in zone`);
    reasons.push(`${population.toLocaleString()} residents`);

    return {
      circuitId: `CIRCUIT-${zone}`,
      reason: reasons.join("; "),
      estCrewHours: 2 + signals.length * 0.25 + (hospitalUrgency > 0 ? 1 : 0),
      facilities: zoneFacilities.map((f) => f.id),
      priorityScore: Math.round(priorityScore * 100) / 100,
    };
  });

  // Deterministic order: score desc, then circuitId asc for stable ties.
  return ranks.sort(
    (a, b) => b.priorityScore - a.priorityScore || a.circuitId.localeCompare(b.circuitId),
  );
}
