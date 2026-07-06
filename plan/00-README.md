# CrisisGrid — Implementation Plan Package

> **Multi-Agent Smart City Crisis Command Center**
> A complete, build-ready plan. Read documents in order. Every document is written so that a coding agent can implement it without asking questions.

---

## 1. Product definition

| Field | Value |
|---|---|
| **Name** | CrisisGrid |
| **One-liner** | An AI command center where nine specialized agents ingest city data, debate response options, and produce an approvable, evidence-backed incident action plan in minutes instead of hours. |
| **Problem** | During cascading urban crises (outage + storm + traffic failure), human operators must fuse weather, grid, traffic, shelter, and population data under extreme time pressure. Information is siloed, second-order risks are missed, and coordination is slow. |
| **Target user** | City Emergency Operations Center (EOC) operators; secondary: utility, traffic, shelter, and communications coordinators. |
| **Why agents** | No single model call can (a) hold domain-specific reasoning for 6+ domains, (b) surface *disagreements* between domains (fastest route vs. flood risk), (c) enforce safety gates on actions, and (d) re-plan when conditions change. Specialized agents with tools + a commander that synthesizes and arbitrates is the correct architecture, not a convenience. |
| **Why this can win** | It hits every rubric axis at once: real multi-agent collaboration (parallel → debate → critique → synthesis), a real MCP server with ~35 tools, real open data (NWS weather, OSM roads) blended with a deterministic scenario engine, a map-first cinematic dashboard, human-in-the-loop approval gates, a full eval suite, a professional incident report artifact, and a documented path from demo mode to live operations mode. |

**The demo sentence that wins:** the operator types one sentence, and within ~60 seconds the room watches agents disagree about an evacuation route, a commander resolve the conflict with evidence, a safety agent block an unapproved alert, and a complete incident action plan appear — then the operator asks *"what if the bridge closes?"* and the whole plan visibly re-forms.

---

## 2. Verdict (final recommendation, up front)

**Yes — pursue this concept.** It is strong enough to win *if and only if* the following are true by demo day:

1. The **scenario engine is deterministic** — the demo never depends on live API availability.
2. **Agent collaboration is visible** — the Agent Room shows real disagreement and resolution, not concatenated paragraphs.
3. The **what-if re-plan** works end-to-end and shows a *diff* of the plan.
4. **Safety gates fire on camera** — a blocked action and an approval flow are shown in the video.
5. The **eval suite runs green in CI** and is shown in the writeup.

The path to competitive: build in the milestone order in `11-build-milestones.md`. The backend/agents/tools come first; the dashboard is built against a stable event stream; polish is last. Do not invert this order.

---

## 3. Rubric coverage map

| Rubric concept | Where CrisisGrid satisfies it |
|---|---|
| Google ADK Multi-Agent System | 9 ADK agents (LlmAgent + ParallelAgent + LoopAgent patterns), doc `04-agents.md` |
| MCP Server in code | Dedicated MCP server package with ~35 tools, doc `05-mcp-tools.md` |
| Antigravity usage in video | Build the project in Antigravity/Cursor; record agent-assisted dev segment for video (doc `02`, demo script §7) |
| Security features | Approval gates, action classification, audit log, no committed keys, doc `09-safety-security.md` |
| Deployability | Docker Compose + Cloud Run deploy shown in video, doc `03-architecture.md` §9 |
| Agent skills / CLI | `crisisgrid` CLI (run scenario, run evals, generate report), doc `03` §8 |
| Meaningful tool use | Every agent finding cites tool calls with raw evidence, docs `04`, `05` |
| Real/realistic data | NWS + Open-Meteo + OSM real data; seeded geospatial synthetic data, doc `06-data-strategy.md` |
| Safety / human-in-the-loop | Action queue with safe/approval/blocked tiers, doc `09` |
| Evals | 16-category eval suite with Vitest, doc `10-evaluation-plan.md` |

---

## 4. Document index

Read and build in this order:

| # | File | What it contains | Build phase |
|---|---|---|---|
| 00 | `00-README.md` | This file. Product definition, verdict, rubric map. | — |
| 01 | `01-product-strategy.md` | Winning differentiation vs. typical winners; judging strategy. | — |
| 02 | `02-demo-scenario.md` | The exact cascading-crisis scenario, timeline, and 6-part demo script. | Design |
| 03 | `03-architecture.md` | Full system architecture, monorepo folder structure, event flow, deployment. | M1 |
| 04 | `04-agents.md` | All 9 agents: role, prompt contract, I/O schemas, tools, failure modes. | M2–M3 |
| 05 | `05-mcp-tools.md` | Every MCP tool: name, purpose, input/output schema, safety tier, data source. | M1–M2 |
| 06 | `06-data-strategy.md` | Real API adapters, synthetic dataset design, seed data, schemas. | M1 |
| 07 | `07-scenario-engine.md` | Scenario engine, timeline events, what-if simulation, plan diffing. | M2, M4 |
| 08 | `08-ui-ux.md` | All 8 screens, layout wireframes, component tree, visual direction. | M3–M4 |
| 09 | `09-safety-security.md` | Action classification, approval queue, audit trail, key handling. | M2–M3 |
| 10 | `10-evaluation-plan.md` | 16 eval categories, fixtures, CI wiring. | M4 |
| 11 | `11-build-milestones.md` | 5 milestones with exit criteria and task-level breakdown. | All |
| 12 | `12-risks-and-mitigations.md` | Honest risk register with concrete mitigations. | — |
| 13 | `13-live-data-real-app-plan.md` | Runtime modes, provider adapters, source metadata, server-driven dashboard, and live-mode evals for making CrisisGrid a real live-data app. | Live product |

---

## 5. Non-negotiable principles (apply to every document)

1. **Tool-first**: agents never call raw APIs; every data access goes through an MCP tool. Evals verify no bypass.
2. **Deterministic demo**: scenario data is seeded and replayable; live APIs enhance but never gate the demo.
3. **Honest simulation**: every simulated action is labeled `SIMULATED` in UI, logs, and reports. Never pretend synthetic data is real.
4. **Evidence or it didn't happen**: every finding carries `evidence[]` (tool call refs + data), `confidence`, and `assumptions[]`.
5. **Human approval**: no external-facing or dispatch-like action executes without an operator click, ever.
6. **Schemas everywhere**: all agent outputs and tool I/O validate against Zod schemas. A malformed output is a failed eval.
7. **No secrets in git**: `.env.example` only; keys loaded at runtime; server-side only.
8. **Live data is explicit**: real app mode must label every value with source, provider, timestamp, freshness, and fallback state. See `13-live-data-real-app-plan.md`.

---

## 6. Glossary (used across all documents)

| Term | Meaning |
|---|---|
| **Incident** | Structured object describing a crisis (type, zones, severity, time, constraints). |
| **Finding** | A single structured agent output: `{finding, severity, confidence, evidence, recommendedAction, assumptions}`. |
| **Assessment** | The set of findings one agent produces for one incident revision. |
| **Plan / IAP** | Incident Action Plan — the Commander's synthesized, prioritized output. |
| **Action** | A discrete executable step with a safety tier (`safe` / `needs_approval` / `blocked`). |
| **Scenario** | A seeded, replayable crisis dataset + timeline of injected events. |
| **Tick** | One step of scenario time advancement (5 simulated minutes). |
| **What-if** | A hypothetical event injection that triggers selective agent re-runs and a plan diff. |
| **Zone** | A geographic cell of the demo city grid with population and facility data. |
