import type { Db, ScenarioEngine } from "@crisisgrid/engine";
import { broadcast } from "../sse/bus.js";
import { runtimeSnapshot } from "../routes/runtime.js";
import { applyLiveImport, LiveImportRequest } from "./imports.js";
import { refreshLiveProviders } from "./live.js";

export interface ProviderJobStatus {
  id: string;
  kind: "weather-refresh" | "import-feed";
  enabled: boolean;
  intervalMs: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  runs: number;
  failures: number;
  note: string;
}

export interface ProviderScheduler {
  status(): ProviderJobStatus[];
  runNow(jobId?: string): Promise<ProviderJobStatus[]>;
  stop(): void;
}

interface Job {
  status: ProviderJobStatus;
  run: () => Promise<unknown>;
  timer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_WEATHER_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_IMPORT_INTERVAL_MS = 60 * 1000;

export function startProviderScheduler(db: Db, engine: ScenarioEngine): ProviderScheduler {
  const jobs = new Map<string, Job>();
  const enabled = envFlag("PROVIDER_SCHEDULER_ENABLED", true);
  const weatherIntervalMs = envNumber("WEATHER_REFRESH_INTERVAL_MS", DEFAULT_WEATHER_INTERVAL_MS);
  const importIntervalMs = envNumber("LIVE_IMPORT_FEED_INTERVAL_MS", DEFAULT_IMPORT_INTERVAL_MS);
  const feedUrls = envList("LIVE_IMPORT_FEED_URLS");

  addJob(jobs, {
    id: "weather.open-meteo",
    kind: "weather-refresh",
    enabled,
    intervalMs: weatherIntervalMs,
    note: enabled ? "Keeps Open-Meteo forecast cache fresh while runtime mode is live." : "Provider scheduler disabled.",
    run: async () => {
      const runtime = runtimeSnapshot(db);
      if (runtime.mode !== "live") return { skipped: true, reason: "runtime mode is demo" };
      return refreshLiveProviders(db, engine, runtime.scenarioId, { force: true });
    },
  });

  addJob(jobs, {
    id: "imports.live-feed",
    kind: "import-feed",
    enabled: enabled && feedUrls.length > 0,
    intervalMs: importIntervalMs,
    note: feedUrls.length
      ? `Polls ${feedUrls.length} configured LiveImportRequest feed URL(s).`
      : "No LIVE_IMPORT_FEED_URLS configured.",
    run: async () => {
      const runtime = runtimeSnapshot(db);
      if (runtime.mode !== "live") return { skipped: true, reason: "runtime mode is demo" };
      const imports = [];
      for (const url of feedUrls) {
        imports.push(...await fetchImportFeed(url, runtime.scenarioId));
      }
      const results = imports.map((body) => applyLiveImport(db, engine, body));
      return { imports: results.length, results };
    },
  });

  for (const job of jobs.values()) {
    if (!job.status.enabled) continue;
    schedule(job);
    void runJob(job);
  }

  return {
    status: () => [...jobs.values()].map((job) => ({ ...job.status })),
    runNow: async (jobId?: string) => {
      const selected = jobId ? [jobs.get(jobId)].filter(Boolean) as Job[] : [...jobs.values()];
      for (const job of selected) {
        await runJob(job);
      }
      return [...jobs.values()].map((job) => ({ ...job.status }));
    },
    stop: () => {
      for (const job of jobs.values()) {
        if (job.timer) clearInterval(job.timer);
        job.timer = null;
        job.status.nextRunAt = null;
      }
    },
  };
}

function addJob(
  jobs: Map<string, Job>,
  input: Omit<ProviderJobStatus, "lastStartedAt" | "lastOkAt" | "lastError" | "nextRunAt" | "runs" | "failures"> & {
    run: () => Promise<unknown>;
  },
): void {
  jobs.set(input.id, {
    run: input.run,
    timer: null,
    status: {
      id: input.id,
      kind: input.kind,
      enabled: input.enabled,
      intervalMs: input.intervalMs,
      nextRunAt: input.enabled ? nextRunAt(input.intervalMs) : null,
      lastStartedAt: null,
      lastOkAt: null,
      lastError: null,
      runs: 0,
      failures: 0,
      note: input.note,
    },
  });
}

function schedule(job: Job): void {
  job.timer = setInterval(() => {
    void runJob(job);
  }, job.status.intervalMs);
}

async function runJob(job: Job): Promise<void> {
  if (!job.status.enabled) return;
  job.status.lastStartedAt = new Date().toISOString();
  job.status.runs += 1;
  try {
    const result = await job.run();
    job.status.lastOkAt = new Date().toISOString();
    job.status.lastError = null;
    broadcast({ type: "providers.scheduler.ok", payload: { jobId: job.status.id, result } });
  } catch (error) {
    job.status.failures += 1;
    job.status.lastError = error instanceof Error ? error.message : String(error);
    broadcast({ type: "providers.scheduler.error", payload: { jobId: job.status.id, error: job.status.lastError } });
  } finally {
    job.status.nextRunAt = nextRunAt(job.status.intervalMs);
  }
}

async function fetchImportFeed(url: string, scenarioId: string): Promise<LiveImportRequest[]> {
  const response = await fetch(url, { headers: feedHeaders() });
  if (!response.ok) {
    throw new Error(`feed ${url} returned ${response.status}`);
  }
  const payload = await response.json() as unknown;
  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.imports)
      ? payload.imports
      : [payload];
  return items.map((item) => {
    const provider = isRecord(item) && typeof item.provider === "string" ? item.provider : `feed:${hostName(url)}`;
    return LiveImportRequest.parse({ scenarioId, provider, ...asRecord(item) });
  });
}

function feedHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env.LIVE_IMPORT_FEED_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const extra = process.env.LIVE_IMPORT_FEED_HEADERS_JSON;
  if (!extra) return headers;
  const parsed = JSON.parse(extra) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") headers[key] = value;
  }
  return headers;
}

function nextRunAt(intervalMs: number): string {
  return new Date(Date.now() + intervalMs).toISOString();
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(10_000, Math.round(parsed));
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function hostName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "configured-feed";
  }
}
