// One-command dev: starts the API server, the Python agent service, and the
// web app together with consistent env loading, then health-checks all three.
//
//   pnpm dev
//
// The agent service is optional (needs the Python venv + GOOGLE_API_KEY);
// if it can't start, the server and web app still run and the UI's replay
// mode keeps the demo alive.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(join(root, ".env"));

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8080);
const AGENTS_PORT = Number(process.env.AGENTS_PORT ?? 8090);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

const COLORS = { server: "\x1b[35m", agents: "\x1b[33m", web: "\x1b[36m" };
const RESET = "\x1b[0m";
const children = [];

function prefixed(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === "win32" });
  const tag = `${COLORS[name] ?? ""}[${name}]${RESET}`;
  const pipe = (stream) =>
    stream.on("data", (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) console.log(`${tag} ${line}`);
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => console.log(`${tag} exited (${code ?? "signal"})`));
  children.push(child);
  return child;
}

console.log(`\nCrisisGrid dev — server :${SERVER_PORT} · agents :${AGENTS_PORT} · web :${WEB_PORT}\n`);

prefixed("server", "pnpm", ["--filter", "@crisisgrid/server", "dev"], root);

const python =
  process.platform === "win32"
    ? join(root, "apps", "agents", ".venv", "Scripts", "python.exe")
    : join(root, "apps", "agents", ".venv", "bin", "python");
if (existsSync(python)) {
  prefixed("agents", python, ["-m", "crisisgrid_agents.main"], join(root, "apps", "agents"));
} else {
  console.log(
    "[agents] venv not found — live runs disabled, replay mode still works.\n" +
      "[agents]   python -m venv apps/agents/.venv\n" +
      '[agents]   apps/agents/.venv/Scripts/pip install google-adk mcp fastapi "uvicorn[standard]" httpx',
  );
}

prefixed("web", "pnpm", ["--filter", "@crisisgrid/web", "dev"], root);

// Boot health checks — tell the developer exactly what's up and what isn't.
setTimeout(async () => {
  const checks = [
    ["API server", `http://127.0.0.1:${SERVER_PORT}/api/health`],
    ["Agent service", `http://127.0.0.1:${AGENTS_PORT}/health`],
    ["Web app", `http://localhost:${WEB_PORT}/`],
  ];
  console.log("\n--- boot health ---");
  for (const [name, url] of checks) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      let extra = "";
      if (name === "Agent service") {
        const body = await res.json().catch(() => ({}));
        extra = body.llmConfigured ? " (LLM configured)" : " (WARNING: no GOOGLE_API_KEY — live runs will fail)";
      }
      console.log(`  ${res.ok ? "OK  " : "WARN"} ${name} — ${url}${extra}`);
    } catch {
      console.log(`  DOWN ${name} — ${url}`);
    }
  }
  console.log(`\n  Open http://127.0.0.1:${WEB_PORT}\n`);
}, 7000);

process.on("SIGINT", () => {
  for (const c of children) c.kill();
  process.exit(0);
});

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    process.env[key] = value;
  }
}
