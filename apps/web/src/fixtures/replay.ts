import recorded from "./replay-run.json";

/**
 * A recorded real pipeline run (see scripts/record-replay.mjs).
 * Each entry: { t: ms offset from run start, event: raw NDJSON pipeline event }.
 * Replay mode plays these under a visible "recorded live run" banner —
 * it never impersonates a live run.
 */
export const REPLAY_EVENTS: { t: number; event: Record<string, unknown> }[] = recorded as {
  t: number;
  event: Record<string, unknown>;
}[];
