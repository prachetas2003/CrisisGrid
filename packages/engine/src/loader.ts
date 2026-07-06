import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CityGeoJson,
  FacilitiesFile,
  InitialStateFile,
  NetworkFile,
  ScenarioMeta,
  TimelineFile,
  WhatIfsFile,
  type CityGeoJson as CityGeoJsonT,
  type FacilitiesFile as FacilitiesFileT,
  type InitialStateFile as InitialStateFileT,
  type NetworkFile as NetworkFileT,
  type ScenarioMeta as ScenarioMetaT,
  type TimelineFile as TimelineFileT,
  type WhatIfsFile as WhatIfsFileT,
} from "@crisisgrid/shared";

/**
 * Loads and Zod-validates a scenario dataset directory
 * (plan/06-data-strategy.md §3). Any schema violation throws at load time —
 * a scenario that doesn't validate never reaches the engine.
 */

export interface ScenarioDataset {
  meta: ScenarioMetaT;
  city: CityGeoJsonT;
  facilities: FacilitiesFileT;
  network: NetworkFileT;
  initialState: InitialStateFileT;
  timeline: TimelineFileT;
  whatifs: WhatIfsFileT;
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf-8"));
}

export function loadScenarioDataset(dir: string): ScenarioDataset {
  const dataset: ScenarioDataset = {
    meta: ScenarioMeta.parse(readJson(dir, "meta.json")),
    city: CityGeoJson.parse(readJson(dir, "city.geojson")),
    facilities: FacilitiesFile.parse(readJson(dir, "facilities.json")),
    network: NetworkFile.parse(readJson(dir, "network.json")),
    initialState: InitialStateFile.parse(readJson(dir, "initial-state.json")),
    timeline: TimelineFile.parse(readJson(dir, "timeline.json")),
    whatifs: WhatIfsFile.parse(readJson(dir, "whatifs.json")),
  };
  validateCrossReferences(dataset);
  return dataset;
}

/** Referential integrity beyond per-file schemas (backs eval 15). */
export function validateCrossReferences(d: ScenarioDataset): void {
  const errors: string[] = [];
  const zoneIds = new Set(
    d.city.features
      .filter((f) => f.properties.kind === "zone")
      .map((f) => (f.properties as { zoneId: string }).zoneId),
  );
  const corridorIds = new Set(d.network.corridors.map((c) => c.id));
  const bridgeIds = new Set(
    d.city.features
      .filter((f) => f.properties.kind === "bridge")
      .map((f) => (f.properties as { bridgeId: string }).bridgeId),
  );
  const floodplainIds = new Set(
    d.city.features
      .filter((f) => f.properties.kind === "floodplain")
      .map((f) => (f.properties as { floodplainId: string }).floodplainId),
  );

  for (const f of d.facilities.facilities) {
    if (!zoneIds.has(f.zone)) errors.push(`facility ${f.id} references unknown zone ${f.zone}`);
    if (f.corridorId && !corridorIds.has(f.corridorId))
      errors.push(`facility ${f.id} references unknown corridor ${f.corridorId}`);
    for (const z of f.feeds ?? [])
      if (!zoneIds.has(z)) errors.push(`substation ${f.id} feeds unknown zone ${z}`);
  }
  for (const r of d.network.routes) {
    for (const c of r.corridorIds)
      if (!corridorIds.has(c)) errors.push(`route ${r.id} references unknown corridor ${c}`);
    for (const b of r.bridgeIds)
      if (!bridgeIds.has(b)) errors.push(`route ${r.id} references unknown bridge ${b}`);
    for (const fp of r.floodplainIds)
      if (!floodplainIds.has(fp)) errors.push(`route ${r.id} references unknown floodplain ${fp}`);
    if (!zoneIds.has(r.fromZone) || !zoneIds.has(r.toZone))
      errors.push(`route ${r.id} endpoints reference unknown zones`);
  }
  for (const c of d.network.corridors)
    for (const z of c.zones)
      if (!zoneIds.has(z)) errors.push(`corridor ${c.id} references unknown zone ${z}`);

  if (errors.length > 0)
    throw new Error(`Scenario cross-reference validation failed:\n  ${errors.join("\n  ")}`);
}
