import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioEngine, openDb } from "@crisisgrid/engine";

/**
 * `crisisgrid` CLI (plan/03-architecture.md §8) — rubric item "agent skills / CLI".
 * M1 commands: scenario load|tick|state, mcp inspect, evals.
 * M2+ adds: assess, whatif, report.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function makeEngine(): ScenarioEngine {
  const db = openDb(process.env.DATABASE_PATH ?? join(REPO_ROOT, "data", "crisisgrid.sqlite"));
  return new ScenarioEngine(db, join(REPO_ROOT, "scenarios"));
}

const program = new Command("crisisgrid").description(
  "CrisisGrid — multi-agent smart city crisis command center",
);

const scenario = program.command("scenario").description("Deterministic scenario engine");

scenario
  .command("load")
  .argument("[scenarioId]", "scenario to load", "westside-cascade")
  .description("Load (or reset) a scenario to tick 0")
  .action((scenarioId: string) => {
    const engine = makeEngine();
    const result = engine.load(scenarioId);
    const meta = engine.dataset(scenarioId).meta;
    console.log(`Loaded scenario '${meta.name}' (${scenarioId})`);
    console.log(`  tick ${result.tick} · sim time ${result.simTime}`);
    console.log(`  ${meta.description}`);
    console.log(`  data honesty: ${meta.dataHonesty}`);
  });

scenario
  .command("tick")
  .option("--to <tick>", "advance to this tick", (v) => parseInt(v, 10))
  .option("-n <ticks>", "advance by N ticks", (v) => parseInt(v, 10), 1)
  .option("--scenario <id>", "scenario id", "westside-cascade")
  .description("Advance simulated time (5 min per tick), firing timeline events")
  .action((opts: { to?: number; n: number; scenario: string }) => {
    const engine = makeEngine();
    const current = engine.currentTick(opts.scenario);
    const steps = opts.to !== undefined ? Math.max(0, opts.to - current) : opts.n;
    if (steps === 0) {
      console.log(`Already at tick ${current} (${engine.simTimeAt(opts.scenario, current)})`);
      return;
    }
    const results = engine.tick(opts.scenario, steps);
    for (const r of results) {
      console.log(`tick ${String(r.tick).padStart(2)} · ${r.simTime.slice(11, 16)}`);
      for (const e of r.firedEvents) console.log(`   ⚡ ${e.id}: ${e.announcement}`);
    }
  });

scenario
  .command("state")
  .option("--scenario <id>", "scenario id", "westside-cascade")
  .option("--type <entityType>", "filter by entity type")
  .description("Print current entity state (optionally filtered by type)")
  .action((opts: { scenario: string; type?: string }) => {
    const engine = makeEngine();
    const tick = engine.currentTick(opts.scenario);
    const entities = engine
      .stateAt(opts.scenario, tick)
      .filter((e) => !opts.type || e.entityType === opts.type);
    console.log(`Scenario ${opts.scenario} · tick ${tick} · ${engine.simTimeAt(opts.scenario, tick)}`);
    for (const e of entities) {
      console.log(`  [${e.entityType}] ${e.entityId}: ${JSON.stringify(e.state)}`);
    }
  });

const mcp = program.command("mcp").description("MCP server utilities");

async function mcpClient() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["tsx", join(REPO_ROOT, "packages", "mcp-server", "src", "index.ts")],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "crisisgrid-cli", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

mcp
  .command("inspect")
  .description("Spawn the MCP server over stdio and list every registered tool + schema")
  .action(async () => {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    console.log(`crisisgrid-tools MCP server: ${tools.length} tools\n`);
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      const params = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).join(", ");
      console.log(`  ${t.name}(${params})`);
      console.log(`      ${t.description?.split(". ")[0] ?? ""}`);
    }
    await client.close();
  });

mcp
  .command("call")
  .argument("<tool>", "tool name, dotted or underscored (e.g. grid.get_outages)")
  .argument("[argsJson]", "JSON arguments, or @path/to/args.json (shell-quoting safe)", "{}")
  .description("Call one MCP tool through the real server (smoke testing / demos)")
  .action(async (tool: string, argsJson: string) => {
    if (argsJson.startsWith("@")) {
      const { readFileSync } = await import("node:fs");
      argsJson = readFileSync(argsJson.slice(1), "utf8");
    }
    const client = await mcpClient();
    const result = await client.callTool({
      name: tool.replaceAll(".", "_"),
      arguments: JSON.parse(argsJson) as Record<string, unknown>,
    });
    const content = (result.content as { type: string; text?: string }[]) ?? [];
    for (const c of content) {
      if (c.type === "text" && c.text) {
        try {
          console.log(JSON.stringify(JSON.parse(c.text), null, 2));
        } catch {
          console.log(c.text);
        }
      }
    }
    await client.close();
    if (result.isError) process.exit(1);
  });

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:8080";

program
  .command("assess")
  .argument("<operatorText...>", "free-text incident description")
  .option("--scenario <id>", "scenario id")
  .description("Run the full multi-agent assessment headless, streaming pipeline events")
  .action(async (words: string[], opts: { scenario?: string }) => {
    const operatorText = words.join(" ");
    console.log(`▶ assess: "${operatorText}"\n`);
    let res: Response;
    try {
      res = await fetch(`${SERVER_URL}/api/incidents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorText, scenarioId: opts.scenario }),
      });
    } catch {
      console.error(`Server unreachable at ${SERVER_URL}. Start it with: pnpm dev:server`);
      process.exit(1);
    }
    if (!res.ok || !res.body) {
      console.error(`Server responded ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failed = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          failed = printPipelineEvent(JSON.parse(line) as Record<string, unknown>) || failed;
        } catch {
          console.log(line);
        }
      }
    }
    process.exit(failed ? 1 : 0);
  });

function printPipelineEvent(e: Record<string, unknown>): boolean {
  switch (e.type) {
    case "run.start":
      console.log(`● run ${e.incidentId as string} on scenario ${e.scenarioId as string}`);
      return false;
    case "phase":
      console.log(`\n━━ phase: ${e.phase as string} ━━`);
      return false;
    case "agent.status":
      console.log(`  [${e.agentId as string}] ${e.state as string}`);
      return false;
    case "agent.tool_call":
      console.log(`  [${e.agentId as string}] → ${e.tool as string}`);
      return false;
    case "agent.finding": {
      const f = e.finding as { id: string; severity: string; finding: string };
      console.log(`  ✦ ${f.id} [${f.severity}] ${f.finding}${e.amended ? " (amended)" : ""}`);
      return false;
    }
    case "conflict.detected": {
      const c = e.conflict as { conflictId: string; summary: string };
      console.log(`  ⚔ CONFLICT ${c.conflictId}: ${c.summary}`);
      return false;
    }
    case "debate.turn": {
      const t = e.turn as { fromAgent: string; stance: string; text: string };
      console.log(`  ↳ ${t.fromAgent} ${t.stance.toUpperCase()}: ${t.text}`);
      return false;
    }
    case "safety.review": {
      const r = e.review as { verdict: string; notes: string };
      console.log(`  ⚖ safety (loop ${e.loop as number}): ${r.verdict} — ${r.notes}`);
      return false;
    }
    case "plan.final": {
      const p = e.plan as { revision: number; riskScore: number; actions: unknown[]; objectives: string[] };
      console.log(`\n  ✔ PLAN rev ${p.revision} · risk ${p.riskScore}/100 · ${p.actions.length} actions`);
      for (const o of p.objectives) console.log(`     - ${o}`);
      return false;
    }
    case "run.complete":
      console.log(`\n● complete: ${e.findings as number} findings, ${e.conflicts as number} conflicts, ${e.debateTurns as number} debate turns, plan rev ${e.planRevision as number}`);
      return false;
    case "run.error":
    case "agent.error":
      console.error(`  ✖ ${(e.agentId as string) ?? "run"}: ${e.error as string}`);
      return e.type === "run.error";
    default:
      return false;
  }
}

const actionsCmd = program.command("actions").description("Human-approval action queue");

actionsCmd
  .command("list")
  .option("--status <status>", "filter: queued|approved|rejected|executed|blocked")
  .description("List queued/decided actions")
  .action(async (opts: { status?: string }) => {
    const qs = opts.status ? `?status=${opts.status}` : "";
    const res = await fetch(`${SERVER_URL}/api/actions${qs}`);
    const { actions } = (await res.json()) as { actions: Record<string, unknown>[] };
    for (const a of actions) {
      const payload = a.payload as { title?: string; tool?: string };
      console.log(`  ${a.id as string} [${a.status as string}] ${a.kind as string} — ${payload.title ?? payload.tool ?? ""}`);
    }
    if (actions.length === 0) console.log("  (queue empty)");
  });

actionsCmd
  .command("approve")
  .argument("<actionId>")
  .option("--operator <name>", "operator name", "cli-operator")
  .description("Approve a queued action; the server mints a single-use token and executes it")
  .action(async (actionId: string, opts: { operator: string }) => {
    const res = await fetch(`${SERVER_URL}/api/actions/${actionId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operator: opts.operator }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    if (!res.ok) process.exit(1);
  });

actionsCmd
  .command("reject")
  .argument("<actionId>")
  .option("--operator <name>", "operator name", "cli-operator")
  .option("--reason <reason>", "why", "rejected by operator")
  .description("Reject a queued action")
  .action(async (actionId: string, opts: { operator: string; reason: string }) => {
    const res = await fetch(`${SERVER_URL}/api/actions/${actionId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operator: opts.operator, reason: opts.reason }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    if (!res.ok) process.exit(1);
  });

program
  .command("report")
  .argument("<incidentId>")
  .description("Render and print the incident brief markdown (deterministic sections from DB)")
  .action(async (incidentId: string) => {
    const { ToolContext, executeTool } = await import("@crisisgrid/mcp-server");
    const ctx = new ToolContext();
    const outcome = await executeTool(ctx, "report.export_markdown", { incidentId });
    if (outcome.kind !== "ok") {
      console.error(JSON.stringify(outcome, null, 2));
      process.exit(1);
    }
    const data = (outcome.result as { data: { reportId: string; markdown: string } }).data;
    console.log(data.markdown);
    console.error(`\n(saved as ${data.reportId})`);
  });

program
  .command("evals")
  .description("Run the eval suite (determinism, geo schema, policy, approval-gate evals)")
  .action(() => {
    const result = spawnSync("npx", ["vitest", "run", "--dir", "evals/ts"], {
      stdio: "inherit",
      cwd: REPO_ROOT,
      shell: process.platform === "win32",
    });
    process.exit(result.status ?? 1);
  });

program.parseAsync(process.argv);
