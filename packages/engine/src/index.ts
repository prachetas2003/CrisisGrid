export { openDb, defaultDbPath, type Db } from "./db.js";
export { loadScenarioDataset, validateCrossReferences, type ScenarioDataset } from "./loader.js";
export { ScenarioEngine, canonicalJson, type TickResult, type EntityRow } from "./engine.js";
export {
  computeRiskOverlay,
  effectiveCongestion,
  band,
  RISK_WEIGHTS,
  type RiskOverlay,
  type ZoneRisk,
} from "./risk.js";
export { estimateRestorationPriority, type RestorationRank } from "./restoration.js";
export { pointInPolygon, distanceKm, polygonCentroid } from "./geo.js";
export { auditLog, verifyAuditChain, type AuditEntry } from "./audit.js";
