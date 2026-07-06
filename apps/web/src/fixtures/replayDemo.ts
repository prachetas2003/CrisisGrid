import type { ActionItem, CommsDraft } from "../lib/types";

/** Human-readable draft bodies for replay — no internal IDs or ISO timestamps. */
export const REPLAY_DRAFT_BODIES: Record<string, string> = {
  "draft-7d6eb6e5-a847-4085-b78b-74aba0ba9b9f":
    "ALERT: Heavy rain expected in Cedar Heights and Westbank starting around 7:10 PM. Riverbend General Hospital is on backup generators. Localized flooding likely along the riverside. Wind gusts up to 65 km/h. Dark traffic signals in affected areas. Exercise extreme caution. THIS IS A SIMULATED EXERCISE.",
  "draft-50725818-9203-4c7d-bc3e-f285add3e648":
    "Emergency Services update: Westbank faces high flood risk with heavy rain from 7:10 PM. Riverbend General Hospital is on backup generator power with limited fuel. No viable evacuation routes identified from Cedar Heights or Westbank. Shelter demand (5,000+) exceeds available beds (2,020). Evaluate shelter-in-place strategies and activate flood response protocols for Westbank.",
};

/** Queued approval actions injected at replay completion when the recorded plan has none. */
export const REPLAY_DEMO_ACTIONS: ActionItem[] = [
  {
    id: "act-replay-sms",
    kind: "public_comms",
    tier: "needs_approval",
    status: "queued",
    payload: {
      title: "Publish public SMS alert to residents",
      tool: "comms.send_sandbox_alert",
      args: { draftId: "draft-7d6eb6e5-a847-4085-b78b-74aba0ba9b9f" },
      preview: REPLAY_DRAFT_BODIES["draft-7d6eb6e5-a847-4085-b78b-74aba0ba9b9f"],
    },
    matchedRules: [{ id: "R-04", reason: "Public alerts require operator approval before sandbox publish" }],
    requested_by: "agents",
    approved_by: null,
    approved_at: null,
    executed_at: null,
    blocked_reason: null,
    created_at: new Date().toISOString(),
  },
  {
    id: "act-replay-shelter",
    kind: "recommendation",
    tier: "needs_approval",
    status: "queued",
    payload: {
      title: "Assign 800 residents to Lincoln High School shelter",
      tool: "shelters.assign_population",
      args: { shelterId: "SHL-LHS", population: 800, fromZone: "Z-05" },
      preview: "Records a simulated assignment of 800 Westbank residents to Lincoln High School shelter, updating occupancy from 60 to 860 of 1,200 capacity.",
    },
    matchedRules: [{ id: "R-01", reason: "Shelter assignments that change occupancy require operator approval" }],
    requested_by: "agents",
    approved_by: null,
    approved_at: null,
    executed_at: null,
    blocked_reason: null,
    created_at: new Date().toISOString(),
  },
];

export function enrichReplayDrafts(drafts: CommsDraft[]): CommsDraft[] {
  return drafts.map((d) => ({
    ...d,
    urgency: d.urgency || "high",
    issues: d.issues ?? [],
    createdAt: d.createdAt || new Date().toISOString(),
    body: d.body || REPLAY_DRAFT_BODIES[d.draftId] || "Simulated advisory update. THIS IS A SIMULATED EXERCISE.",
  }));
}
