// Launch the Python ADK agent service using the project venv (cross-platform).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(root, "apps", "agents");
loadEnv(join(root, ".env"));

const python =
  process.platform === "win32"
    ? join(agentsDir, ".venv", "Scripts", "python.exe")
    : join(agentsDir, ".venv", "bin", "python");

if (!existsSync(python)) {
  console.error("Agent venv missing. Create it first:");
  console.error("  python -m venv apps/agents/.venv");
  console.error(
    "  apps/agents/.venv/Scripts/pip install google-adk mcp fastapi \"uvicorn[standard]\" httpx",
  );
  process.exit(1);
}

const child = spawn(python, ["-m", "crisisgrid_agents.main"], {
  cwd: agentsDir,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(trimmed.slice(separator + 1).trim());
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
