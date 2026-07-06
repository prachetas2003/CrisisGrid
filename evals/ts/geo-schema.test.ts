import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScenarioDataset,
  pointInPolygon,
  polygonCentroid,
} from "@crisisgrid/engine";
import type { ZoneFeature } from "@crisisgrid/shared";

/**
 * Eval 15 — Map/geo schema validation (plan/10-evaluation-plan.md).
 * All scenario GeoJSON validates (Zod parse happens inside loadScenarioDataset),
 * every facility lies inside its declared zone polygon, and every route's
 * corridors/bridges/floodplains exist (cross-reference check in loader).
 */

const SCENARIO_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scenarios",
  "westside-cascade",
);

describe("eval 15: map/geo schema validation", () => {
  // Throws (failing the test) if any file breaks its Zod schema or cross-references.
  const dataset = loadScenarioDataset(SCENARIO_DIR);

  const zones = dataset.city.features.filter(
    (f): f is ZoneFeature => f.properties.kind === "zone",
  );

  it("has exactly 16 zones with plausible populations", () => {
    expect(zones).toHaveLength(16);
    for (const z of zones) {
      expect(z.properties.population).toBeGreaterThan(10_000);
      expect(z.properties.population).toBeLessThan(60_000);
    }
    const total = zones.reduce((a, z) => a + z.properties.population, 0);
    expect(total).toBeGreaterThan(400_000); // ~480k city per plan/02
  });

  it("every facility lies inside its declared zone polygon", () => {
    for (const f of dataset.facilities.facilities) {
      const zone = zones.find((z) => z.properties.zoneId === f.zone);
      expect(zone, `zone ${f.zone} for facility ${f.id}`).toBeDefined();
      const inside = pointInPolygon([f.lon, f.lat], zone!.geometry.coordinates[0]!);
      expect(inside, `${f.id} (${f.name}) must be inside ${f.zone}`).toBe(true);
    }
  });

  it("matches the seeded city inventory (plan/02 §1)", () => {
    const byKind = (k: string) => dataset.facilities.facilities.filter((f) => f.kind === k);
    expect(byKind("substation")).toHaveLength(4);
    expect(byKind("hospital")).toHaveLength(3);
    expect(byKind("shelter")).toHaveLength(6);
    expect(byKind("signal")).toHaveLength(28);
    const shelterCapacity = byKind("shelter").reduce((a, f) => a + (f.capacity ?? 0), 0);
    expect(shelterCapacity).toBe(450 + 300 + 800 + 150 + 200 + 350);
  });

  it("routes reference real corridors, bridges, and floodplains", () => {
    // Cross-reference validation already ran in loadScenarioDataset; assert the
    // demo-critical topology explicitly:
    const rt12 = dataset.network.routes.find((r) => r.id === "RT-12")!;
    const rt08 = dataset.network.routes.find((r) => r.id === "RT-08")!;
    expect(rt12.floodplainIds.length).toBeGreaterThan(0); // Route 12 IS flood-exposed
    expect(rt08.floodplainIds).toHaveLength(0); // Route 8 is flood-safe
    expect(rt08.baseEtaMin - rt12.baseEtaMin).toBe(6); // "+6 minutes" debate number
    expect(rt08.bridgeIds).toContain("BR-MAIN"); // WHATIF-BRIDGE kills RT-08
  });

  it("every zone polygon is closed and every centroid is inside it", () => {
    for (const z of zones) {
      const ring = z.geometry.coordinates[0]!;
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      expect(pointInPolygon(polygonCentroid(ring), ring)).toBe(true);
    }
  });

  it("what-if events only patch entities that exist or are created via set", () => {
    const initialIds = new Set(
      dataset.initialState.entities.map((e) => `${e.entityType}:${e.entityId}`),
    );
    for (const w of dataset.whatifs.whatifs) {
      for (const p of w.patches) {
        if (p.op === "merge") {
          expect(
            initialIds.has(`${p.entityType}:${p.entityId}`),
            `${w.id} merges into missing entity ${p.entityType}:${p.entityId}`,
          ).toBe(true);
        }
      }
      expect(w.affectedAgents.length).toBeGreaterThan(0);
    }
  });
});
