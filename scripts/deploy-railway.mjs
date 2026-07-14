#!/usr/bin/env node
/**
 * Deploy CrisisGrid to Railway using the root Dockerfile.
 *
 * Prerequisite (one time):  npx @railway/cli login
 *
 * Usage:  node scripts/deploy-railway.mjs
 *
 * Reads GOOGLE_API_KEY from .env and sets Railway variables — never prints the key.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const path = join(root, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function railway(...args) {
  const r = spawnSync("npx", ["--yes", "@railway/cli", ...args], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function railwayOut(...args) {
  return spawnSync("npx", ["--yes", "@railway/cli", ...args], {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
}

console.log("CrisisGrid → Railway deploy\n");

const whoami = railwayOut("whoami");
if (whoami.status !== 0) {
  console.error("\nNot logged in to Railway. Run this first:\n");
  console.error("  npx @railway/cli login\n");
  process.exit(1);
}

const env = loadEnv();
if (!env.GOOGLE_API_KEY) {
  console.error("GOOGLE_API_KEY missing in .env — add your Gemini key, then retry.");
  process.exit(1);
}

// Link or create project if needed
if (!existsSync(join(root, ".railway"))) {
  console.log("Creating Railway project (first deploy)…");
  railway("init", "--name", "crisisgrid");
}

console.log("Setting environment variables on Railway…");
railway("variables", "--set", `GOOGLE_API_KEY=${env.GOOGLE_API_KEY}`);
railway("variables", "--set", "DEMO_MODE=true");
railway("variables", "--set", "DATABASE_PATH=/app/data/crisisgrid.sqlite");
railway("variables", "--set", "AGENTS_PORT=8090");

console.log("\nBuilding and deploying Docker image (5–10 min first time)…\n");
railway("up", "--detach");

console.log("\nGenerating public URL…");
railway("domain");

console.log("\nDone. Open the URL above, or run:  npx @railway/cli open");
