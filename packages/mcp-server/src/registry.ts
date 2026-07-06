import type { z } from "zod";
import type { ProposedAction } from "@crisisgrid/shared";
import type { ToolContext } from "./context.js";
import { gridTools } from "./tools/grid.js";
import { geoTools } from "./tools/geo.js";
import { shelterTools } from "./tools/shelters.js";
import { resourceTools } from "./tools/resources.js";
import { simTools } from "./tools/sim.js";
import { weatherTools } from "./tools/weather.js";
import { trafficTools } from "./tools/traffic.js";
import { commsTools } from "./tools/comms.js";
import { safetyTools } from "./tools/safety.js";
import { reportTools } from "./tools/report.js";

/**
 * Single source of truth for all MCP tools (plan/05 §4).
 * The MCP tools/list response, docs tables, and `crisisgrid mcp inspect`
 * all derive from this array — they can never drift.
 *
 * Tiers are enforced structurally in execute.ts, not by prompts:
 *  - safe: runs immediately
 *  - approval: without an operator-minted token → enqueued + PENDING_APPROVAL
 *  - blocked: always refused with the matched policy rule + audit entry
 */

export type ToolTier = "safe" | "approval" | "blocked";
export type ToolSource = "scenario" | "computed" | "live";

export interface ToolDef {
  /** Dotted name used in docs and evidence refs, e.g. "grid.get_outages". */
  name: string;
  description: string;
  tier: ToolTier;
  source: ToolSource;
  /** Action kind for the policy table (approval/blocked tools only). */
  actionKind?: ProposedAction["kind"];
  /** Zod object schema for tool arguments. */
  input: z.ZodObject<z.ZodRawShape>;
  /** Optional dry-run used to enrich PENDING_APPROVAL responses. */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
}

/** MCP tool names cannot contain dots; registered as namespace_verb_noun. */
export function mcpName(dotted: string): string {
  return dotted.replaceAll(".", "_");
}

export const REGISTRY: ToolDef[] = [
  ...gridTools,
  ...geoTools,
  ...shelterTools,
  ...resourceTools,
  ...simTools,
  ...weatherTools,
  ...trafficTools,
  ...commsTools,
  ...safetyTools,
  ...reportTools,
];

const seen = new Set<string>();
for (const t of REGISTRY) {
  if (seen.has(t.name)) throw new Error(`Duplicate tool name in registry: ${t.name}`);
  seen.add(t.name);
}
