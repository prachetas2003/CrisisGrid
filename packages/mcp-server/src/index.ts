import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolContext } from "./context.js";
import { executeTool } from "./execute.js";
import { REGISTRY, mcpName } from "./registry.js";

/**
 * CrisisGrid MCP server (plan/05-mcp-tools.md), stdio transport.
 * Agents access ALL data through these tools — there is no other data path
 * from the agent runtime (enforced by eval 13). Tier enforcement happens in
 * execute.ts before any handler runs.
 */

const ctx = new ToolContext();

const server = new McpServer({ name: "crisisgrid-tools", version: "0.2.0" });

for (const tool of REGISTRY) {
  server.registerTool(
    mcpName(tool.name),
    {
      title: tool.name,
      description: `[tier:${tool.tier}] [source:${tool.source}] ${tool.description}`,
      inputSchema: tool.input.shape,
    },
    async (args: Record<string, unknown>) => {
      try {
        const outcome = await executeTool(ctx, tool.name, args ?? {});
        switch (outcome.kind) {
          case "ok":
            return { content: [{ type: "text" as const, text: JSON.stringify(outcome.result) }] };
          case "pending_approval":
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    status: "PENDING_APPROVAL",
                    actionId: outcome.actionId,
                    tool: outcome.tool,
                    preview: outcome.preview,
                    note: outcome.note,
                  }),
                },
              ],
            };
          case "blocked":
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    blocked: true,
                    tool: outcome.tool,
                    reason: outcome.reason,
                    policyRef: outcome.policyRef,
                    auditId: outcome.auditId,
                  }),
                },
              ],
            };
        }
      } catch (err) {
        // Structured tool errors — agents must see failures, never silence.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the MCP protocol channel.
console.error(`crisisgrid-tools MCP server ready: ${REGISTRY.length} tools registered (stdio)`);
