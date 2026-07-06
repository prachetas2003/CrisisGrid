/**
 * Generates JSON Schema files from the Zod source of truth into
 * packages/shared/schema/. The Python agent service (Milestone 2) generates
 * Pydantic models from these files via datamodel-code-generator, so both
 * runtimes validate identical structures (plan/03-architecture.md §1).
 *
 * Run: pnpm gen:schemas
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  CommsDraft,
  DebateTurn,
  Finding,
  Incident,
  IncidentActionPlan,
  PlanDiff,
  PlannedAction,
  TimelineEvent,
  ToolResultEnvelope,
  WhatIfEvent,
} from "../src/index.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
mkdirSync(outDir, { recursive: true });

const schemas = {
  finding: Finding,
  incident: Incident,
  "planned-action": PlannedAction,
  "incident-action-plan": IncidentActionPlan,
  "plan-diff": PlanDiff,
  "debate-turn": DebateTurn,
  "comms-draft": CommsDraft,
  "timeline-event": TimelineEvent,
  "whatif-event": WhatIfEvent,
  "tool-result": ToolResultEnvelope,
} as const;

for (const [name, schema] of Object.entries(schemas)) {
  const json = zodToJsonSchema(schema, { name, target: "jsonSchema7" });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
  console.log(`wrote schema/${name}.json`);
}
