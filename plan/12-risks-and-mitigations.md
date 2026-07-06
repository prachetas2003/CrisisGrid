# 12 — Risks, Mitigations & Final Recommendation

## 1. Risk register (honest)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Scope blow-up** — 9 agents, 35 tools, 8 screens is a lot | High | Fatal if unmanaged | Milestone exit criteria are hard gates; scope-cut ladder (doc 11 §5) pre-decided so cuts take minutes, not debates; agents/tools share one Finding schema and one registry pattern — each additional agent/tool is marginal work, not new architecture |
| 2 | **Polyglot friction** — Python ADK ↔ TS server/MCP seam | Medium | High (integration hell late) | Seam built and smoke-tested in M2 day 1 (hello-world agent calling one MCP tool end-to-end) before any agent logic; schemas generated from one source; if ADK-Python integration stalls > 1 day, fallback: keep ADK for agent definitions but move debate/critique sequencing into the Python service with plain Gemini calls — rubric still satisfied (ADK agents in code) |
| 3 | **Live data unavailability during demo/judging** | Medium | High | `DEMO_MODE` makes the entire demo offline-capable; live adapters are enhancement-only with scenario fallback; rehearse once with network disabled (mandatory M5 step) |
| 4 | **Agent hallucination** (fake zones, invented numbers, vague plans) | High (baseline LLM behavior) | High for judging credibility | Structural: schema-required evidence, numbers must trace to tool calls (eval 3/7/13), zone-ID validation, deterministic risk score, max-6-findings rule; debate + safety critique catch cross-domain nonsense; evals gate prompt regressions |
| 5 | **Simulation credibility** — judges smell fake data | Medium | Medium | Real OSM geometry/POIs, real weather option, realism checklist (doc 06 §6), and *explicit honesty labeling* — claiming less earns more trust |
| 6 | **Pipeline latency** — 60s+ of silence kills the demo | Medium | Medium | Parallel fan-out, Flash for domain agents, streamed SSE findings so the screen is alive within ~5s; latency-theater UI rule (doc 08 §5.4); hard budget measured from M2 |
| 7 | **LLM nondeterminism breaks rehearsed demo** | Medium | High | Low temperature, structure-asserting evals run 3× the night before; the deterministic layer (scenario, conflicts, risk scores, tiers) anchors the demo even if wording shifts; fallback recording per beat |
| 8 | **Safety theater accusation** (gates look fake) | Low | Medium | Gates are structural (tokens, registry tiers) and demonstrated live: show the blocked broadcast tool refusing + the audit hash chain; include the prompt-injection eval in the video if built |
| 9 | **What-if diff quality** — diff looks noisy or trivial | Medium | High (it's the wow) | Diff matched on semantic keys in deterministic code; Commander only narrates; fixtures define the exact expected delta (doc 02 §5) so quality is eval-gated, not eyeballed |
| 10 | **API cost/quota during evals + rehearsal** | Low | Medium | Flash everywhere but Commander; full agent-eval suite ~25 runs; nightly not per-push; keep a second API key ready |
| 11 | **Video overrun / unclear pitch** | Medium | Medium (30 pts at stake) | Script written in doc 02 §7 with per-segment timings; record demo beats separately and edit; dry-run the narration against the rubric checklist |
| 12 | **Team unfamiliarity with ADK/MCP specifics** | Medium | Medium | M2 day-1 spike is exactly this learning; both have good quickstarts; the architecture never depends on exotic features (LlmAgent, ParallelAgent, LoopAgent, MCPToolset, stdio/SSE transports only) |
| 13 | **Fake-live credibility gap** — dashboard motion looks impressive but data is static or scripted | High | High | Execute `13-live-data-real-app-plan.md` L1/L2 before adding more polish: server-driven dashboard state, actual SSE, source metadata, provider health, and visible fallback labels |

## 2. What would make us lose (pre-mortem)

1. We built the dashboard first and the agents were shallow. → Prevented by milestone order.
2. The demo broke live because it needed the internet or a lucky LLM output. → Prevented by DEMO_MODE + structure anchoring + rehearsal rules.
3. Judges couldn't tell the agents actually used tools. → Prevented by the tool-call ticker, evidence popovers, and eval 13.
4. The writeup undersold the system. → Prevented by README structure + Judge Mode + eval table.
5. We ran out of time polishing P1s. → Prevented by the scope-cut ladder.

## 3. Final recommendation

**Pursue CrisisGrid. The concept is strong enough to win, and the plan above is the path.**

Reasons for confidence:
- It hits **every** rubric axis with real substance, not checkbox gestures: 9 genuinely specialized ADK agents in a four-phase collaboration protocol; a 35-tool MCP server that is the sole data path; structural human-in-the-loop safety; deterministic deployable demo; a 16-category eval suite — most competitors will have zero evals.
- Its three wow moments (agent debate, what-if plan diff, on-camera safety block) are all **deterministically triggerable**, which is the difference between a demo that wows and a demo you pray through.
- The honest data posture (real map/weather, labeled simulation) converts the biggest weakness of city-scale projects — fake data — into a credibility feature.

Conditions (repeat of doc 00 §2, because they are the whole game):
1. Build in milestone order — pipeline before pixels.
2. Keep evals 8/9/14 green from the moment they exist.
3. Rehearse offline; record from the deployed instance.
4. Cut scope only via the ladder; never cut determinism, gates, the what-if diff, the report, or evals.

If the timeline collapses to under ~6 build days, shrink to 6 agents (merge shelter+resources into one, comms+briefing into one, drop 311) and 24 tools — the architecture and demo beats survive intact. Do **not** respond to time pressure by keeping all features and skipping evals/rehearsal; that is the losing branch.

**Next step:** create the repo, execute `11-build-milestones.md` M1, and hand documents 03–07 to the coding agents as their implementation specs.
