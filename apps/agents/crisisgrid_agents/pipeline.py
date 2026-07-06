"""The four-phase assessment pipeline (plan/03 §3, plan/04).

Phase 1  intake parse -> parallel domain fan-out (asyncio.gather)
Phase 2  DETERMINISTIC conflict detection (code, not LLM — plan/07 §6)
Phase 3  debate round between conflicting agents (max 1 round per conflict)
Phase 4  commander synthesis -> safety critique loop (max 3) -> comms + briefing

Yields NDJSON-able event dicts; the Node orchestration server persists them
and re-broadcasts over SSE. This module never writes the database directly.
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import Any, AsyncIterator, Callable, Optional, Type, TypeVar

from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner
from google.genai import types as genai_types
from pydantic import BaseModel, ValidationError

from . import agents as agent_defs
from . import config
from .schemas import (
    DebateTurn,
    Finding,
    FindingList,
    Incident,
    IncidentActionPlan,
    SafetyReview,
)

T = TypeVar("T", bound=BaseModel)

SEVERITY_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
ROUTE_RE = re.compile(r"RT-[A-Z0-9]+")
SHELTER_RE = re.compile(r"SHL-[A-Z]+")

Emit = Callable[[dict[str, Any]], Any]


# ---------------------------------------------------------------------------
# Agent execution helpers
# ---------------------------------------------------------------------------

def _is_transient_llm_error(err: Exception) -> bool:
    text = str(err).lower()
    transient_markers = (
        "503",
        "unavailable",
        "high demand",
        "temporarily",
        "timeout",
        "timed out",
        "deadline",
        "resource_exhausted",
        "rate limit",
    )
    return any(marker in text for marker in transient_markers)


def _extract_json(text: str) -> str:
    """Tolerate accidental markdown fences around the JSON object."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1]
    return text


class AgentSession:
    """One ADK runner+session per agent invocation, with JSON retry."""

    def __init__(self, agent: LlmAgent, label: str, emit: Emit):
        self.agent = agent
        self.label = label
        self.emit = emit
        self.runner = InMemoryRunner(agent=agent, app_name="crisisgrid")
        self.session_id: Optional[str] = None

    async def _send(self, text: str) -> str:
        if self.session_id is None:
            session = await self.runner.session_service.create_session(
                app_name="crisisgrid", user_id="operator"
            )
            self.session_id = session.id
        content = genai_types.Content(role="user", parts=[genai_types.Part(text=text)])
        for attempt in range(4):
            final_text = ""
            try:
                async with asyncio.timeout(config.AGENT_CALL_TIMEOUT_SECONDS):
                    async for event in self.runner.run_async(
                        user_id="operator", session_id=self.session_id, new_message=content
                    ):
                        for fc in event.get_function_calls():
                            await self.emit(
                                {
                                    "type": "agent.tool_call",
                                    "agentId": self.label,
                                    "tool": fc.name,
                                    "args": fc.args,
                                }
                            )
                        for fr in event.get_function_responses():
                            tool_call_id = None
                            try:
                                payload = fr.response
                                if isinstance(payload, dict):
                                    # MCP text content -> our ToolResult envelope JSON
                                    texts = [
                                        c.get("text")
                                        for c in payload.get("content", [])
                                        if isinstance(c, dict) and c.get("type") == "text"
                                    ]
                                    if texts and texts[0]:
                                        envelope = json.loads(texts[0])
                                        tool_call_id = envelope.get("toolCallId")
                            except (json.JSONDecodeError, AttributeError, TypeError):
                                pass
                            await self.emit(
                                {
                                    "type": "agent.tool_result",
                                    "agentId": self.label,
                                    "tool": fr.name,
                                    "toolCallId": tool_call_id,
                                }
                            )
                        if event.is_final_response() and event.content and event.content.parts:
                            final_text = "".join(p.text or "" for p in event.content.parts if p.text)
                return final_text
            except Exception as err:  # noqa: BLE001 - ADK surfaces provider throttles as generic errors
                if attempt >= 3 or not _is_transient_llm_error(err):
                    raise
                await self.emit(
                    {
                        "type": "agent.retry",
                        "agentId": self.label,
                        "error": f"transient model error; retrying attempt {attempt + 2}/4: {str(err)[:260]}",
                    }
                )
                await asyncio.sleep(2 * (attempt + 1))
        raise RuntimeError("unreachable")

    async def ask(self, prompt: str, model_cls: Type[T], retries: int = 1) -> T:
        """Send prompt, parse JSON into model_cls; feed validation errors back once."""
        text = await self._send(prompt)
        for attempt in range(retries + 1):
            try:
                return model_cls.model_validate_json(_extract_json(text))
            except (ValidationError, json.JSONDecodeError) as err:
                if attempt >= retries:
                    raise
                await self.emit(
                    {"type": "agent.retry", "agentId": self.label, "error": str(err)[:400]}
                )
                text = await self._send(
                    "Your output failed schema validation. Fix these errors and respond "
                    f"with ONLY the corrected JSON object:\n{str(err)[:1500]}"
                )
        raise RuntimeError("unreachable")

    async def close(self) -> None:
        try:
            await self.runner.close()
        except Exception:  # noqa: BLE001 — cleanup must never mask pipeline results
            pass


# ---------------------------------------------------------------------------
# Phase 2: deterministic conflict detection (code, never LLM)
# ---------------------------------------------------------------------------

def _finding_text(f: Finding) -> str:
    parts = [f.finding, f.detail]
    if f.recommendedAction:
        parts += [f.recommendedAction.title, f.recommendedAction.description]
    return " ".join(parts)


def _compact_finding(f: Finding) -> dict[str, Any]:
    action = None
    if f.recommendedAction:
        action = {
            "title": f.recommendedAction.title,
            "description": f.recommendedAction.description,
            "tier": f.recommendedAction.tier,
            "timeWindow": f.recommendedAction.timeWindow,
            "targetTeam": f.recommendedAction.targetTeam,
        }
    return {
        "id": f.id,
        "agentId": f.agentId,
        "finding": f.finding,
        "detail": f.detail[:500],
        "severity": f.severity,
        "confidence": f.confidence,
        "affectedZones": f.affectedZones,
        "evidenceRefs": [e.ref for e in f.evidence[:4]],
        "recommendedAction": action,
    }


def _compact_debate_turn(turn: DebateTurn) -> dict[str, Any]:
    return {
        "conflictId": turn.conflictId,
        "fromAgent": turn.fromAgent,
        "toAgent": turn.toAgent,
        "stance": turn.stance,
        "text": turn.text[:500],
        "evidenceRefs": turn.evidenceRefs[:4],
    }


def detect_conflicts(findings: list[Finding]) -> list[dict[str, Any]]:
    """Pairwise checks per plan/07 §6. Returns at most 2 conflicts (demo focus)."""
    conflicts: list[dict[str, Any]] = []

    # (a) Route conflicts: one agent RECOMMENDS a route another agent flags as hazardous.
    recommenders: dict[str, list[Finding]] = {}
    for f in findings:
        if f.recommendedAction is None:
            continue
        for route in ROUTE_RE.findall(f.recommendedAction.title + " " + f.recommendedAction.description):
            recommenders.setdefault(route, []).append(f)
    for f in findings:
        if SEVERITY_RANK[f.severity] < SEVERITY_RANK["medium"]:
            continue
        for route in set(ROUTE_RE.findall(_finding_text(f))):
            for rec in recommenders.get(route, []):
                if rec.agentId != f.agentId:
                    conflicts.append(
                        {
                            "conflictId": f"conf-{route.lower()}-{rec.agentId}-{f.agentId}",
                            "kind": "route_hazard",
                            "subject": route,
                            "agents": [rec.agentId, f.agentId],
                            "findings": [rec.id, f.id],
                            "summary": (
                                f"{rec.agentId} recommends {route} "
                                f"({rec.recommendedAction.title if rec.recommendedAction else rec.finding}) but "
                                f"{f.agentId} flags {route}: {f.finding}"
                            ),
                        }
                    )

    # (b) Shelter viability: shelter agent plans a shelter located in a zone the
    # power agent marks high/critical.
    SHELTER_ZONES = {
        "SHL-CLB": "Z-01",
        "SHL-WCC": "Z-05",
        "SHL-NGC": "Z-09",
        "SHL-LHS": "Z-06",
        "SHL-FGP": "Z-07",
        "SHL-DRC": "Z-15",
    }
    power_hot_zones = {
        z
        for f in findings
        if f.agentId == "power" and SEVERITY_RANK[f.severity] >= SEVERITY_RANK["high"]
        for z in f.affectedZones
    }
    for f in findings:
        if f.agentId != "shelter" or f.recommendedAction is None:
            continue
        shelters = SHELTER_RE.findall(_finding_text(f))
        hot_shelters = [s for s in shelters if SHELTER_ZONES.get(s) in power_hot_zones]
        if hot_shelters:
            overlap = {SHELTER_ZONES[s] for s in hot_shelters}
            power_f = next(
                (
                    p
                    for p in findings
                    if p.agentId == "power" and set(p.affectedZones) & overlap
                ),
                None,
            )
            if power_f:
                conflicts.append(
                    {
                        "conflictId": f"conf-shelter-{sorted(overlap)[0].lower()}",
                        "kind": "shelter_power",
                        "subject": ",".join(sorted(set(hot_shelters))),
                        "agents": ["shelter", "power"],
                        "findings": [f.id, power_f.id],
                        "summary": (
                            f"shelter plans {', '.join(sorted(set(hot_shelters)))} in zones {', '.join(sorted(overlap))} that "
                            f"power marks {power_f.severity}: {power_f.finding}"
                        ),
                    }
                )

    # Dedupe by (kind, subject); keep the demo focused.
    seen: set[tuple[str, str]] = set()
    unique = []
    for c in conflicts:
        key = (c["kind"], c["subject"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique[:2]


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------

async def run_assessment(
    operator_text: str,
    scenario_id: str = config.DEFAULT_SCENARIO,
    incident_id: Optional[str] = None,
) -> AsyncIterator[dict[str, Any]]:
    incident_id = incident_id or f"inc-{uuid.uuid4().hex[:8]}"
    queue: asyncio.Queue[Optional[dict[str, Any]]] = asyncio.Queue()

    async def emit(event: dict[str, Any]) -> None:
        await queue.put(event)

    async def drive() -> None:
        sessions: list[AgentSession] = []
        try:
            await emit({"type": "run.start", "incidentId": incident_id, "scenarioId": scenario_id})

            # ---- Phase 1a: intake --------------------------------------------------
            await emit({"type": "phase", "phase": "intake"})
            intake = AgentSession(agent_defs.build_intake(), "intake", emit)
            sessions.append(intake)
            incident = await intake.ask(
                f"Operator request: {operator_text!r}\n"
                f"scenarioId: {scenario_id}\nincident id to use: {incident_id}\n"
                "Parse into the Incident JSON.",
                Incident,
            )
            incident.id = incident_id
            incident.scenarioId = scenario_id
            await emit({"type": "incident.parsed", "incident": incident.model_dump()})

            # ---- Phase 1b: parallel domain fan-out ---------------------------------
            await emit({"type": "phase", "phase": "assessment"})
            domain = agent_defs.build_domain_agents()
            incident_brief = json.dumps(incident.model_dump(), indent=None)

            async def run_domain(agent_id: str, agent: LlmAgent) -> list[Finding]:
                await emit({"type": "agent.status", "agentId": agent_id, "state": "working"})
                s = AgentSession(agent, agent_id, emit)
                sessions.append(s)
                result = await s.ask(
                    f"Incident (from intake): {incident_brief}\n"
                    f"scenarioId: {scenario_id}. Assess your domain now. "
                    f"Use finding ids prefixed for your domain and agentId '{agent_id}'.",
                    FindingList,
                )
                for f in result.findings:
                    f.agentId = agent_id  # enforce ownership regardless of LLM output
                    await emit({"type": "agent.finding", "finding": f.model_dump()})
                await emit({"type": "agent.status", "agentId": agent_id, "state": "done"})
                return result.findings

            results = await asyncio.gather(
                *(run_domain(aid, ag) for aid, ag in domain.items()), return_exceptions=True
            )
            findings: list[Finding] = []
            for agent_id, res in zip(domain.keys(), results):
                if isinstance(res, BaseException):
                    await emit({"type": "agent.error", "agentId": agent_id, "error": str(res)[:400]})
                else:
                    findings.extend(res)
            if not findings:
                raise RuntimeError("No domain agent produced findings; aborting run")

            # ---- Phase 2: deterministic conflict detection -------------------------
            await emit({"type": "phase", "phase": "conflict_detection"})
            conflicts = detect_conflicts(findings)
            for c in conflicts:
                await emit({"type": "conflict.detected", "conflict": c})

            # ---- Phase 3: debate ----------------------------------------------------
            debate_turns: list[DebateTurn] = []
            if conflicts:
                await emit({"type": "phase", "phase": "debate"})
                findings_by_id = {f.id: f for f in findings}
                for c in conflicts:
                    a_id, b_id = c["agents"][0], c["agents"][1]
                    f_a = findings_by_id.get(c["findings"][0])
                    f_b = findings_by_id.get(c["findings"][1])
                    for me, other, mine, theirs in ((a_id, b_id, f_a, f_b), (b_id, a_id, f_b, f_a)):
                        s = AgentSession(agent_defs.build_debater(me), f"{me}(debate)", emit)
                        sessions.append(s)
                        prompt_body = (
                            f"conflictId: {c['conflictId']}\nYou are agent '{me}', the other agent is '{other}'.\n"
                            f"Conflict: {c['summary']}\n"
                            f"YOUR finding: {mine.model_dump_json() if mine else 'n/a'}\n"
                            f"THEIR finding: {theirs.model_dump_json() if theirs else 'n/a'}\n"
                            "Respond with your DebateTurn JSON."
                        )
                        try:
                            turn = await s.ask(prompt_body, DebateTurn)
                            turn.conflictId = c["conflictId"]
                            turn.fromAgent = me  # enforce identity
                            debate_turns.append(turn)
                            await emit({"type": "debate.turn", "turn": turn.model_dump()})
                            if turn.stance == "amend" and turn.amendedFinding is not None:
                                amended = turn.amendedFinding
                                amended.agentId = me
                                findings = [amended if f.id == amended.id else f for f in findings]
                                await emit({"type": "agent.finding", "finding": amended.model_dump(), "amended": True})
                        except Exception as err:  # noqa: BLE001 — a failed turn shouldn't kill the run
                            await emit({"type": "agent.error", "agentId": me, "error": f"debate: {str(err)[:300]}"})

            # ---- Phase 4a: commander synthesis + safety critique loop ---------------
            await emit({"type": "phase", "phase": "synthesis"})
            commander = AgentSession(agent_defs.build_commander(), "commander", emit)
            safety = AgentSession(agent_defs.build_safety(), "safety", emit)
            sessions += [commander, safety]

            synth_prompt = (
                f"Incident: {incident_brief}\n"
                f"scenarioId: {scenario_id}\n"
                f"All findings ({len(findings)}): "
                + json.dumps([_compact_finding(f) for f in findings])
                + "\nConflicts detected (resolve each explicitly): "
                + json.dumps(conflicts)
                + "\nDebate turns: "
                + json.dumps([_compact_debate_turn(t) for t in debate_turns])
                + f"\nProduce the IncidentActionPlan JSON now (incidentId '{incident_id}', revision 1)."
            )
            plan = await commander.ask(synth_prompt, IncidentActionPlan)
            plan.incidentId = incident_id
            await emit({"type": "plan.draft", "plan": plan.model_dump(), "revision": plan.revision})

            for loop in range(1, config.MAX_CRITIQUE_LOOPS + 1):
                review = await safety.ask(
                    f"Review this Incident Action Plan (loop {loop}):\n{plan.model_dump_json()}\n"
                    "Respond with the SafetyReview JSON.",
                    SafetyReview,
                )
                await emit({"type": "safety.review", "review": review.model_dump(), "loop": loop})
                if review.verdict == "approved":
                    break
                if loop == config.MAX_CRITIQUE_LOOPS:
                    plan.unresolvedRisks.append(
                        "Safety critique loop exhausted after "
                        f"{config.MAX_CRITIQUE_LOOPS} rounds; outstanding: "
                        + "; ".join(r.issue for r in review.revisions)
                    )
                    await emit({"type": "safety.loop_exhausted", "outstanding": [r.model_dump() for r in review.revisions]})
                    break
                plan = await commander.ask(
                    "The safety agent requires revisions:\n"
                    + json.dumps([r.model_dump() for r in review.revisions])
                    + f"\nProduce the FULL revised IncidentActionPlan JSON (revision {plan.revision + 1}).",
                    IncidentActionPlan,
                )
                plan.incidentId = incident_id
                plan.revision = max(plan.revision, loop + 1)
                await emit({"type": "plan.draft", "plan": plan.model_dump(), "revision": plan.revision})

            await emit({"type": "plan.final", "plan": plan.model_dump()})

            # ---- Phase 4b: comms drafts + briefing narrative -------------------------
            await emit({"type": "phase", "phase": "comms"})
            comms = AgentSession(agent_defs.build_comms(), "comms", emit)
            sessions.append(comms)
            try:
                comms_text = await comms._send(
                    f"Approved plan: {plan.model_dump_json()}\n"
                    f"Key findings: {json.dumps([_compact_finding(f) for f in findings if SEVERITY_RANK[f.severity] >= 2])}\n"
                    f"scenarioId: {scenario_id}, incidentId: {incident_id}. Draft and validate now."
                )
                await emit({"type": "comms.drafts", "raw": _extract_json(comms_text)})
            except Exception as err:  # noqa: BLE001
                await emit({"type": "agent.error", "agentId": "comms", "error": str(err)[:300]})

            await emit({"type": "phase", "phase": "briefing"})
            briefing = AgentSession(agent_defs.build_briefing(), "briefing", emit)
            sessions.append(briefing)
            narrative: dict[str, str] = {}
            try:
                brief_text = await briefing._send(
                    f"Final plan: {plan.model_dump_json()}\nIncident: {incident_brief}\n"
                    "Write the two narrative sections JSON."
                )
                narrative = json.loads(_extract_json(brief_text))
            except Exception as err:  # noqa: BLE001
                await emit({"type": "agent.error", "agentId": "briefing", "error": str(err)[:300]})
            await emit({"type": "briefing.sections", "sections": narrative})

            await emit(
                {
                    "type": "run.complete",
                    "incidentId": incident_id,
                    "findings": len(findings),
                    "conflicts": len(conflicts),
                    "debateTurns": len(debate_turns),
                    "planRevision": plan.revision,
                    "riskScore": plan.riskScore,
                }
            )
        except Exception as err:  # noqa: BLE001 — surface, never swallow
            await emit({"type": "run.error", "incidentId": incident_id, "error": str(err)[:600]})
        finally:
            for s in sessions:
                await s.close()
            await queue.put(None)

    task = asyncio.create_task(drive())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield event
    finally:
        if not task.done():
            task.cancel()
