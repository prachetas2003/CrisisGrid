/**
 * Library entry point (no side effects — importing this does NOT start the
 * MCP server). The orchestration server uses these exports to execute
 * operator-approved actions through the exact same tier-enforced choke
 * point that agent MCP calls go through.
 */
export { ToolContext } from "./context.js";
export { executeTool, findTool, type ExecuteResult } from "./execute.js";
export { REGISTRY, mcpName, type ToolDef, type ToolTier } from "./registry.js";
export { buildBundle, renderIncidentBrief, type ReportBundle } from "./tools/reportRender.js";
export { fetchOpenMeteoForecast, type LiveForecastPeriod } from "./adapters/openMeteo.js";
