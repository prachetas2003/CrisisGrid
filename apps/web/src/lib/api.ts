import type { ActionItem, CommsDraft, MapSnapshot, PipelineEvent } from "./types";

/** All backend access for the UI. Everything proxies through Vite → server. */

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${url}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const getSnapshot = (tick?: number) =>
  fetchJson<MapSnapshot>(`/api/map/snapshot${tick !== undefined ? `?tick=${tick}` : ""}`);

export const getActions = () => fetchJson<{ actions: ActionItem[] }>("/api/actions");

export const approveAction = (id: string, operator: string) =>
  fetchJson(`/api/actions/${id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operator }),
  });

export const rejectAction = (id: string, operator: string, reason: string) =>
  fetchJson(`/api/actions/${id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operator, reason }),
  });

export const getCommsDrafts = () => fetchJson<{ drafts: CommsDraft[] }>("/api/comms/drafts");

export const queueDraftForApproval = (draftId: string) =>
  fetchJson<{ actionId: string; status: string }>(`/api/comms/drafts/${draftId}/queue`, { method: "POST" });

export const getFeed = () =>
  fetchJson<{ feed: { id: number; channel: string; body: string; published_at: string }[] }>("/api/feed");

export const getReport = (incidentId: string) =>
  fetchJson<{ reportId: string; markdown: string }>(`/api/incidents/${incidentId}/report`, { method: "POST" });

export const advanceTime = (scenarioId: string, ticks: number) =>
  fetchJson<{ tick: number; simTime: string }>(`/api/scenario/tick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId, ticks }),
  });

export const loadScenario = (scenarioId: string) =>
  fetchJson<{ scenarioId: string; tick: number; simTime: string }>(`/api/scenario/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  });

export const forkScenario = (scenarioId: string, eventIds: string[]) =>
  fetchJson<{ scenarioId: string; forkId: string; changedEntities: string[] }>(`/api/scenario/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId, eventIds }),
  });

export const getForkState = (scenarioId: string, forkId: string) =>
  fetchJson<{ entities: { entityType: string; entityId: string; state: Record<string, unknown> }[] }>(
    `/api/scenario/${scenarioId}/state?forkId=${encodeURIComponent(forkId)}`,
  );

/** Apply a what-if to the live timeline (operator "adopt") — mutates shared demo state. */
export const injectScenarioEvent = (scenarioId: string, eventId: string) =>
  fetchJson<{ scenarioId: string; eventId: string; changedEntities: string[] }>(`/api/scenario/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId, eventId, confirm: true }),
  });

export const getJudgeInfo = () =>
  fetchJson<{
    tools: { name: string; tier: string; source: string; description: string }[];
    evals: { files: number; tests: number };
    health: Record<string, unknown>;
  }>("/api/judge/info");

export const getHealth = () =>
  fetchJson<{
    ok: boolean;
    agents?: { online: boolean; llmConfigured: boolean };
  }>("/api/health");

/**
 * Start an assessment run and stream NDJSON pipeline events.
 * Returns an abort function. onEvent fires for every parsed line.
 */
export function streamAssessment(
  operatorText: string,
  onEvent: (event: PipelineEvent) => void,
  onDone: (error?: string) => void,
): () => void {
  const controller = new AbortController();
  (async () => {
    let res: Response;
    try {
      res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorText }),
        signal: controller.signal,
      });
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      let message = `Agent service unavailable (${res.status})`;
      try {
        const parsed = JSON.parse(body) as { error?: string; hint?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* keep default */
      }
      onDone(message);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
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
            onEvent(JSON.parse(line) as PipelineEvent);
          } catch {
            /* skip unparseable line */
          }
        }
      }
      onDone();
    } catch (err) {
      if (!controller.signal.aborted) onDone(err instanceof Error ? err.message : String(err));
    }
  })();
  return () => controller.abort();
}

/** Subscribe to the server's SSE bus. Returns an unsubscribe function. */
export function subscribeSse(onEvent: (type: string, payload: unknown) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as { type: string; payload: unknown };
      onEvent(parsed.type, parsed.payload);
    } catch {
      /* keep-alive or malformed */
    }
  };
  return () => es.close();
}
