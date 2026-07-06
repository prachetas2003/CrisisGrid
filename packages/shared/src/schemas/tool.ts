import { z } from "zod";

/**
 * Tool envelope + registry metadata (plan/05-mcp-tools.md §1).
 * Every MCP tool result is wrapped in ToolResult so agents can cite
 * toolCallId as evidence and the UI can badge live vs scenario sources.
 */

export const ToolSource = z.enum(["live", "scenario", "computed", "manual", "synthetic"]);
export type ToolSource = z.infer<typeof ToolSource>;

export const DataFreshness = z.enum(["fresh", "stale", "fallback", "unknown"]);
export type DataFreshness = z.infer<typeof DataFreshness>;

export const SourceMetadata = z.object({
  source: ToolSource,
  provider: z.string(),
  asOf: z.string(),
  freshness: DataFreshness,
  confidence: z.number().min(0).max(1).optional(),
  note: z.string().optional(),
});
export type SourceMetadata = z.infer<typeof SourceMetadata>;

export const ToolResultEnvelope = z.object({
  toolCallId: z.string(),
  source: ToolSource,
  provider: z.string().optional(),
  /** Sim-time (scenario/computed) or wall-time (live) the data is valid as of. */
  asOf: z.string(),
  freshness: DataFreshness.optional(),
  note: z.string().optional(),
  data: z.unknown(),
});
export type ToolResultEnvelope = z.infer<typeof ToolResultEnvelope>;

export const ToolTier = z.enum(["safe", "approval", "blocked"]);
export type ToolTier = z.infer<typeof ToolTier>;
