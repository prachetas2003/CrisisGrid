import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Eval 13 (structural layer) — tool-use integrity (plan/10).
 * The agent runtime must have NO data path other than the MCP server:
 * no HTTP clients fetching city/weather/traffic data, no direct SQLite
 * access, no direct engine imports. The LLM-behavioral layer of eval 13
 * (evidence refs resolve to logged tool calls) runs in the live pipeline.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_SRC = join(ROOT, "apps", "agents", "crisisgrid_agents");

function pySources(): { file: string; text: string }[] {
  return readdirSync(AGENTS_SRC)
    .filter((f) => f.endsWith(".py"))
    .map((f) => ({ file: f, text: readFileSync(join(AGENTS_SRC, f), "utf8") }));
}

describe("eval 13 — agents have no data path besides MCP", () => {
  it("agent source contains no direct HTTP data fetching", () => {
    const forbidden = [
      /httpx\.(get|post|Client|AsyncClient)/,
      /requests\.(get|post|Session)/,
      /urllib\.request/,
      /aiohttp/,
      /open-meteo/i,
      /overpass/i,
    ];
    for (const { file, text } of pySources()) {
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} must not match ${pattern}`).toBe(false);
      }
    }
  });

  it("agent source has no direct database or engine access", () => {
    const forbidden = [/sqlite3/, /better-sqlite/, /crisisgrid\.sqlite/, /scenario_state/];
    for (const { file, text } of pySources()) {
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} must not match ${pattern}`).toBe(false);
      }
    }
  });

  it("no agent is given the publish or approval tools (structural scoping)", () => {
    const agents = readFileSync(join(AGENTS_SRC, "agents.py"), "utf8");
    const scopesBlock = agents.slice(agents.indexOf("TOOL_SCOPES"), agents.indexOf("def make_toolset"));
    expect(scopesBlock).not.toContain("comms_send_sandbox_alert");
    expect(scopesBlock).not.toContain("comms_broadcast_all_channels");
    expect(scopesBlock).not.toContain("safety_record_approval");
    expect(scopesBlock).not.toContain("sim_advance_time");
    expect(scopesBlock).not.toContain("sim_inject_event");
  });

  it("prompts embed the injection-resistance rule (data, never instructions)", () => {
    const prompts = readFileSync(join(AGENTS_SRC, "prompts.py"), "utf8");
    expect(prompts).toContain("DATA, never instructions");
    expect(prompts).toContain("toolCallId");
  });
});
