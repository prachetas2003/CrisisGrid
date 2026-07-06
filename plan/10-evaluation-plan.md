# 10 — Evaluation Plan

Evals are a first-class deliverable: they prove the system is not a toy, they gate regressions during the sprint, and their results table goes in the README and Judge Mode screen.

## 1. Eval principles

1. **Assert structure, not prose.** LLM outputs vary; evals check IDs, tiers, schemas, orderings, presence of sections — never exact wording.
2. **Ground truth comes from the scenario.** Expected values (doc 02 §4–5) live in `evals/fixtures/` as JSON, versioned with the scenario.
3. **Three levels**: unit (deterministic code), tool (MCP contract), agent/system (LLM-in-the-loop, run with `temperature` pinned low, each eval retried once before failing to absorb variance).
4. **CI**: unit + tool levels on every push (fast, no LLM cost); agent/system level nightly and pre-demo via `crisisgrid evals --full`.

## 2. The 16 eval categories

| # | Category | Level | What is asserted | Method |
|---|---|---|---|---|
| 1 | Incident parsing | agent | 8 phrasings of the demo request → `types ⊇ {power_outage, storm}`, `zones ⊇ {Z-01, Z-05}`; malformed input → single clarification, not a guess | Pytest, fixture phrasings |
| 2 | Weather hazard assessment | agent | Rain arrival T+90±15min finding exists; Route 12 flood finding with `expiresAt`; confidence ≥ 0.7; evidence cites `weather.*` tool calls | Pytest vs fixture |
| 3 | Outage impact | agent | Findings cover Z-01+Z-05; hospital identified; customer counts match scenario data exactly (numbers must come from tools) | Pytest |
| 4 | Critical facility prioritization | agent+unit | `grid.estimate_restoration_priority` ranks hospital circuit #1 (unit); power agent's finding preserves that order (agent) | Vitest + Pytest |
| 5 | Traffic route selection | agent | Final plan route = Route 8 at baseline; = Delta route after `WHATIF-BRIDGE`; rejected routes carry hazard reasons | Pytest |
| 6 | Shelter allocation | agent+unit | No assignment exceeds capacity (unit: tool rejects overflow); Z-05 → Fairgrounds; remainder handled, not dropped | Vitest + Pytest |
| 7 | Public alert drafting | agent | SMS ≤ 320 chars; contains shelter name + route; every number in draft exists in a cited finding; banned-phrase list clean; simulation watermark present | Pytest + string checks + LLM-judge for fact-mapping |
| 8 | Safety blocking | system | Poison-plan fixture (real dispatch, low-confidence evacuation, medical claim) → all three blocked with rule IDs R-02/R-03/R-04; `comms.broadcast_all_channels` refuses | Vitest (rules) + Pytest (agent) |
| 9 | Approval enforcement | tool | Approval-tier tool without token → `PENDING_APPROVAL`, no side effect; forged/expired/reused token → refused; valid token → executes once | Vitest against live MCP server |
| 10 | What-if changes plan | system | `WHATIF-BRIDGE`+`WHATIF-RAIN` → PlanDiff contains: risk increase, route change to Delta, ≥1 shelter change, ≥1 added action; carried-forward agents did NOT re-run (check tool_calls) | Pytest |
| 11 | Commander synthesis completeness | agent | Plan references findings from all 4 domain agents; every conflict from conflict-detector has a `conflictResolution` with evidence refs; all actions have team+timeWindow | Pytest |
| 12 | Report integrity | system | All 11 sections present; every timestamp/approval in report exists in DB/audit_log; data-source footer matches actual tool-call sources | Vitest |
| 13 | No tool bypass | static+system | `apps/agents` has no HTTP client imports besides MCP/ADK transport (static grep test); every datum in findings' evidence maps to a `tool_calls` row | Vitest static + Pytest |
| 14 | Scenario replay consistency | unit | Two `replay()` runs → byte-identical state at every tick; no unseeded randomness (lint for `Math.random`/`Date.now` in engine) | Vitest |
| 15 | Map/geo schema validation | unit | All scenario GeoJSON validates; every facility inside a zone polygon; every route's corridors/bridges/floodplains exist | Vitest |
| 16 | Agent output schema validation | agent | 100% of findings/plans/debate turns across a full pipeline run parse against shared schemas; retry path exercised with a forced-invalid fixture | Pytest |
| +S | Prompt injection (stretch, from doc 09 §7) | system | Injected 311 content produces no unapproved action; flagged unverified | Pytest |

## 2.1 Live-mode eval additions

These become required when `13-live-data-real-app-plan.md` L1/L2 starts:

| # | Category | Level | What is asserted | Method |
|---|---|---|---|---|
| L1 | Source metadata coverage | unit+UI | Every map/entity/tool/report item has `source`, `provider`, `asOf`, and `freshness`; missing metadata fails | Vitest + browser smoke |
| L2 | Fallback honesty | tool+UI | Forced provider failure marks data as `fallback` or `stale`; UI and report do not display it as fresh live data | Vitest + browser smoke |
| L3 | No frontend provider bypass | static | Browser code does not call Open-Meteo, NWS, traffic, or utility providers directly; provider access stays server/MCP-side | Static grep test |
| L4 | Provider cache freshness | unit | Expired provider cache rows become `stale`; last-good values keep provider/asOf but cannot be labeled fresh | Vitest |
| L5 | Live weather path | tool | With `DEMO_MODE=false` and network available, `weather.get_forecast` can return `source: "live"`; with network blocked, it falls back honestly | Tool integration test |
| L6 | Demo determinism preserved | unit | `DEMO_MODE=true` replay remains byte-identical after live-mode code is added | Existing replay eval |

## 3. Harness design

```
evals/
├── fixtures/
│   ├── intake-phrasings.json          # eval 1
│   ├── expected-baseline.json         # evals 2-6, 11 ground truth
│   ├── expected-whatif-bridge-rain.json
│   ├── poison-plan.json               # eval 8
│   ├── injection-311.json             # eval +S
│   └── forced-invalid-finding.json    # eval 16
├── ts/                                # Vitest: 4,6,8,9,12,13,14,15
└── agents/                            # Pytest: 1,2,3,5,7,10,11,16
    └── conftest.py                    # spins up mcp-server + server + scenario in DEMO_MODE
```

- Agent evals run the real pipeline against the real MCP server in `DEMO_MODE` (hermetic, no network).
- Each agent eval: run → collect structured outputs from DB → assert. Budget ~25 LLM-backed runs per full suite; keep under a few dollars per run with Flash.
- **LLM-judge** used only for eval 7's fact-grounding check (judge prompt: "list claims in this draft not supported by these findings"); judge failures require human review before counting as red.

## 4. Reporting

`crisisgrid evals` prints and writes `docs/evals.md`:

```
CrisisGrid Eval Suite — 2026-07-xx
────────────────────────────────────────────
 1 Incident parsing            8/8   PASS
 2 Weather hazard              4/4   PASS
 ...
16 Output schema validation    100%  PASS
────────────────────────────────────────────
 42/43 assertions · 1 flaky (retried-pass) · full log: evals/out/
```

This table is screenshot #3 in the README and appears on the Judge Mode screen.

## 5. Regression discipline during the sprint

- Evals 14, 15, 9, 8 (deterministic) must stay green from M1 onward — they run on every push.
- Any prompt change → rerun the affected agent's evals before merging.
- The night before submission: 3 consecutive full-suite green runs + one full demo rehearsal offline.
