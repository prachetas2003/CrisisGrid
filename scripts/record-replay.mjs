// Record a REAL pipeline run to the replay fixture used by the web app.
// Requires the full stack running (pnpm dev) with a working GOOGLE_API_KEY.
//
//   node scripts/record-replay.mjs [operator text]
//
// Writes apps/web/src/fixtures/replay-run.json: [{ t: msOffset, event }, ...]
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(join(root, ".env"));

const SERVER = `http://127.0.0.1:${process.env.SERVER_PORT ?? 8080}`;
const operatorText =
  process.argv.slice(2).join(" ") ||
  "Storm knocked out power in Cedar Heights and Westbank, heavy rain is coming, and Riverbend General Hospital is on backup generators. What should we do?";

console.log(`Recording a live run against ${SERVER}`);
console.log(`Operator text: ${operatorText}\n`);

const res = await fetch(`${SERVER}/api/incidents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ operatorText }),
});
if (!res.ok || !res.body) {
  console.error(`Server responded ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const started = Date.now();
const events = [];
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      events.push({ t: Date.now() - started, event });
      console.log(`  +${((Date.now() - started) / 1000).toFixed(1)}s  ${event.type}`);
    } catch {
      /* skip */
    }
  }
}

const terminal = events.at(-1)?.event?.type;
if (terminal !== "run.complete") {
  console.error(`\nRun did not complete cleanly (last event: ${terminal}). Fixture NOT written.`);
  process.exit(1);
}

const out = join(root, "apps", "web", "src", "fixtures", "replay-run.json");
writeFileSync(out, JSON.stringify(events, null, 1));
console.log(`\nWrote ${events.length} events to ${out}`);

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
