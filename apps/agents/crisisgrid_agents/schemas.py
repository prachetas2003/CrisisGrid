"""Pydantic mirrors of the shared Zod schemas (packages/shared/schema/*.json).

Kept deliberately small and hand-synchronized for M2; the generated-from-
JSON-Schema pipeline can replace this file without touching callers.
Validation here is Layer 2 of defense-in-depth (plan/09 §2): a finding
without evidence fails parsing and triggers one retry with the error text.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

AgentId = Literal[
    "intake", "weather", "power", "traffic", "shelter",
    "comms", "safety", "commander", "briefing",
]
Severity = Literal["info", "low", "medium", "high", "critical"]
SafetyTier = Literal["safe", "needs_approval", "blocked"]
TimeWindow = Literal["immediate", "short_term", "next_period"]


class Evidence(BaseModel):
    kind: Literal["tool_call", "dataset", "assumption", "agent_finding"]
    ref: str
    summary: str


class RecommendedAction(BaseModel):
    title: str
    description: str
    tier: SafetyTier
    timeWindow: TimeWindow
    targetTeam: str

    @field_validator("timeWindow", mode="before")
    @classmethod
    def normalize_time_window(cls, value: object) -> object:
        return normalize_time_window(value)

    @field_validator("tier", mode="before")
    @classmethod
    def normalize_tier(cls, value: object) -> object:
        return normalize_tier(value)


class Finding(BaseModel):
    id: str
    agentId: AgentId
    finding: str
    detail: str
    severity: Severity
    confidence: float = Field(ge=0, le=1)
    evidence: list[Evidence] = Field(min_length=1)
    recommendedAction: Optional[RecommendedAction] = None
    assumptions: list[str] = []
    affectedZones: list[str] = []
    expiresAt: Optional[str] = None
    carriedForward: bool = False

    @model_validator(mode="before")
    @classmethod
    def normalize_finding(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        finding = dict(value)
        finding["finding"] = normalize_text(finding.get("finding") or finding.get("summary") or "Finding")
        finding["detail"] = normalize_text(
            finding.get("detail") or finding.get("description") or finding["finding"]
        )
        evidence = finding.get("evidence")
        if not isinstance(evidence, list) or len(evidence) == 0:
            finding["evidence"] = [{
                "kind": "assumption",
                "ref": "schema-fill",
                "summary": "Evidence was not provided by the model; treated as an assumption.",
            }]
        finding["assumptions"] = normalize_string_list(finding.get("assumptions"))
        finding["affectedZones"] = normalize_string_list(finding.get("affectedZones") or finding.get("zones"))
        return finding

    @field_validator("severity", mode="before")
    @classmethod
    def normalize_severity(cls, value: object) -> object:
        return normalize_severity(value)

    @field_validator("confidence", mode="before")
    @classmethod
    def normalize_confidence(cls, value: object) -> object:
        normalized = normalize_number(value)
        if isinstance(normalized, int | float) and normalized > 1 and normalized <= 100:
            return normalized / 100
        return normalized

    @field_validator("assumptions", "affectedZones", mode="before")
    @classmethod
    def normalize_string_lists(cls, value: object) -> object:
        return normalize_string_list(value)


class FindingList(BaseModel):
    findings: list[Finding] = Field(max_length=6)


class Incident(BaseModel):
    id: str
    scenarioId: str
    revision: int = 0
    operatorText: str
    types: list[
        Literal[
            "power_outage", "storm", "flood", "wildfire", "heatwave",
            "traffic_failure", "infrastructure", "other",
        ]
    ]
    zones: list[str]
    simTime: str
    severityHint: Severity
    constraints: list[str] = []
    operatorIntent: str
    clarificationNeeded: Optional[str] = None
    assumptions: list[str] = []

    @field_validator("types", mode="before")
    @classmethod
    def normalize_types(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        normalized: list[str] = []
        for item in value:
            incident_type = normalize_incident_type(item)
            if isinstance(incident_type, str) and incident_type not in normalized:
                normalized.append(incident_type)
        return normalized or ["other"]

    @field_validator("operatorIntent", mode="before")
    @classmethod
    def normalize_operator_intent(cls, value: object) -> object:
        return normalize_text(value)

    @field_validator("constraints", "assumptions", mode="before")
    @classmethod
    def normalize_string_lists(cls, value: object) -> object:
        return normalize_string_list(value)


class PlannedAction(BaseModel):
    id: str
    title: str
    description: str
    tier: SafetyTier
    timeWindow: TimeWindow
    targetTeam: str
    dependsOn: list[str] = []
    sourceFindings: list[str] = []
    simulated: bool = True

    @field_validator("timeWindow", mode="before")
    @classmethod
    def normalize_time_window(cls, value: object) -> object:
        return normalize_time_window(value)

    @field_validator("tier", mode="before")
    @classmethod
    def normalize_tier(cls, value: object) -> object:
        return normalize_tier(value)

    @field_validator("dependsOn", "sourceFindings", mode="before")
    @classmethod
    def normalize_string_lists(cls, value: object) -> object:
        return normalize_string_list(value)


class ConflictResolution(BaseModel):
    conflictId: str
    decision: str
    rationale: str
    evidenceRefs: list[str] = []

    @model_validator(mode="before")
    @classmethod
    def fill_missing_fields(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        filled = dict(value)
        # LLMs often emit only one of decision/rationale; keep both populated.
        if not filled.get("decision"):
            filled["decision"] = filled.get("rationale") or filled.get("resolution") or "resolved"
        if not filled.get("rationale"):
            filled["rationale"] = (
                filled.get("decision")
                or filled.get("reason")
                or filled.get("explanation")
                or "Resolved during commander synthesis."
            )
        if not filled.get("conflictId"):
            filled["conflictId"] = filled.get("id") or "conflict-unknown"
        return filled

    @field_validator("evidenceRefs", mode="before")
    @classmethod
    def normalize_evidence_refs(cls, value: object) -> object:
        return normalize_string_list(value)


class TimePhases(BaseModel):
    immediate: list[str]
    shortTerm: list[str]
    nextPeriod: list[str]

    @model_validator(mode="before")
    @classmethod
    def normalize_keys(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        if "short_term" in normalized and "shortTerm" not in normalized:
            normalized["shortTerm"] = normalized["short_term"]
        if "next_period" in normalized and "nextPeriod" not in normalized:
            normalized["nextPeriod"] = normalized["next_period"]

        for key in ["immediate", "shortTerm", "nextPeriod"]:
            val = normalized.get(key)
            if isinstance(val, dict):
                list_val = next((v for v in val.values() if isinstance(v, list)), None)
                if list_val is not None:
                    normalized[key] = list_val
        return normalized


class IncidentActionPlan(BaseModel):
    incidentId: str
    revision: int
    situationSummary: str
    riskScore: float = Field(ge=0, le=100)
    objectives: list[str]
    actions: list[PlannedAction]
    timePhases: TimePhases
    conflictResolutions: list[ConflictResolution] = []
    commsPlan: list[str] = []
    unresolvedRisks: list[str]
    assumptions: list[str]
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="before")
    @classmethod
    def normalize_plan(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        normalized = dict(value)
        summary = normalized.get("situationSummary")
        if isinstance(summary, dict):
            normalized["situationSummary"] = "; ".join(f"{key}: {val}" for key, val in summary.items())
        risk = normalized.get("riskScore")
        if isinstance(risk, dict):
            normalized["riskScore"] = first_number(risk, ["cityScore", "value", "score", "riskScore"])
        normalized["actions"] = normalize_actions(normalized.get("actions"))
        if "timePhases" not in normalized or not isinstance(normalized.get("timePhases"), dict):
            normalized["timePhases"] = time_phases_from_actions(normalized["actions"])
        return normalized

    @field_validator("objectives", "commsPlan", "unresolvedRisks", "assumptions", mode="before")
    @classmethod
    def normalize_string_lists(cls, value: object) -> object:
        return normalize_string_list(value)

    @field_validator("riskScore", mode="before")
    @classmethod
    def normalize_risk_score(cls, value: object) -> object:
        return normalize_number(value)

    @field_validator("confidence", mode="before")
    @classmethod
    def normalize_confidence(cls, value: object) -> object:
        normalized = normalize_number(value)
        if isinstance(normalized, int | float) and normalized > 1 and normalized <= 100:
            return normalized / 100
        return normalized


class DebateTurn(BaseModel):
    conflictId: str
    round: int = 1
    fromAgent: AgentId
    toAgent: AgentId
    stance: Literal["confirm", "contest", "amend"]
    text: str
    evidenceRefs: list[str] = []
    amendedFinding: Optional[Finding] = None


class SafetyRevision(BaseModel):
    issue: str
    requiredChange: str


class SafetyReview(BaseModel):
    verdict: Literal["approved", "revise"]
    revisions: list[SafetyRevision] = []
    notes: str = ""

    @field_validator("verdict", mode="before")
    @classmethod
    def normalize_verdict(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
        lookup = {
            "approved": "approved",
            "approve": "approved",
            "ok": "approved",
            "pass": "approved",
            "passed": "approved",
            "revise": "revise",
            "revision": "revise",
            "revisions_required": "revise",
            "reject": "revise",
            "rejected": "revise",
            "fail": "revise",
            "failed": "revise",
        }
        return lookup.get(normalized, normalized)

    @field_validator("notes", mode="before")
    @classmethod
    def normalize_notes(cls, value: object) -> object:
        return normalize_text(value) if value is not None else ""

    @model_validator(mode="before")
    @classmethod
    def normalize_revisions(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        review = dict(value)
        revisions = review.get("revisions")
        if revisions is None:
            review["revisions"] = []
        elif isinstance(revisions, dict):
            review["revisions"] = [revisions]
        elif isinstance(revisions, list):
            fixed: list[dict[str, object]] = []
            for item in revisions:
                if isinstance(item, str):
                    fixed.append({"issue": item, "requiredChange": item})
                elif isinstance(item, dict):
                    fixed.append({
                        "issue": normalize_text(item.get("issue") or item.get("problem") or "Issue"),
                        "requiredChange": normalize_text(
                            item.get("requiredChange")
                            or item.get("change")
                            or item.get("fix")
                            or item.get("issue")
                            or "Revise the related action."
                        ),
                    })
            review["revisions"] = fixed
        return review


def normalize_severity(value: object) -> object:
    if not isinstance(value, str):
        return value
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    lookup = {
        "info": "info",
        "informational": "info",
        "low": "low",
        "medium": "medium",
        "med": "medium",
        "moderate": "medium",
        "high": "high",
        "critical": "critical",
        "crit": "critical",
        "severe": "critical",
    }
    return lookup.get(normalized, normalized)


def normalize_time_window(value: object) -> object:
    """Coerce LLM timeWindow shapes into the closed TimeWindow enum.

    Models commonly emit ISO start/end objects instead of the literals
    `immediate` / `short_term` / `next_period`. Map those without failing
    the whole plan parse.
    """
    if value is None or value is False:
        return "immediate"

    if isinstance(value, dict):
        for key in ("timeWindow", "window", "phase", "label", "value", "name", "type"):
            nested = value.get(key)
            if isinstance(nested, str) and nested.strip():
                return normalize_time_window(nested)

        start = value.get("start") or value.get("from") or value.get("begin")
        end = value.get("end") or value.get("to") or value.get("until")
        if isinstance(start, str) or isinstance(end, str):
            return classify_time_span(
                start if isinstance(start, str) else None,
                end if isinstance(end, str) else None,
            )

        # Fall through: unknown object → safer to act now than to drop the plan.
        return "immediate"

    if isinstance(value, (int, float)):
        # Treat numeric hours-from-now as a rough phase bucket.
        hours = float(value)
        if hours <= 2:
            return "immediate"
        if hours <= 12:
            return "short_term"
        return "next_period"

    if not isinstance(value, str):
        return "immediate"

    compact = value.strip().lower().replace("-", "_").replace(" ", "_")
    if not compact:
        return "immediate"

    lookup = {
        "immediate": "immediate",
        "now": "immediate",
        "asap": "immediate",
        "urgent": "immediate",
        "short": "short_term",
        "shortterm": "short_term",
        "short_term": "short_term",
        "near_term": "short_term",
        "nearterm": "short_term",
        "soon": "short_term",
        "next": "next_period",
        "nextperiod": "next_period",
        "next_period": "next_period",
        "later": "next_period",
        "long_term": "next_period",
        "longterm": "next_period",
    }
    if compact in lookup:
        return lookup[compact]

    # CamelCase alias still used by some prompts / old drafts.
    if value.strip() in {"shortTerm", "nextPeriod"}:
        return "short_term" if value.strip() == "shortTerm" else "next_period"

    # If the model wrote a free-text phrase, bucket by keywords.
    if any(token in compact for token in ("immediate", "now", "asap", "0_2", "0-2")):
        return "immediate"
    if any(token in compact for token in ("short", "near", "2_6", "2-6", "hour")):
        return "short_term"
    if any(token in compact for token in ("next", "later", "long", "tomorrow", "period")):
        return "next_period"

    return "immediate"


def classify_time_span(start: str | None, end: str | None) -> TimeWindow:
    """Map an ISO start/end window onto immediate / short_term / next_period."""
    from datetime import datetime

    def parse_iso(raw: str | None) -> datetime | None:
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00").replace(" ", "T"))
        except ValueError:
            return None

    start_dt = parse_iso(start)
    end_dt = parse_iso(end)
    if start_dt and end_dt:
        hours = abs((end_dt - start_dt).total_seconds()) / 3600.0
        if hours <= 2:
            return "immediate"
        if hours <= 12:
            return "short_term"
        return "next_period"
    # Single timestamp or unparsable → act in the current period.
    return "immediate"


def normalize_tier(value: object) -> object:
    if not isinstance(value, str):
        return value
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    lookup = {
        "approval": "needs_approval",
        "needsapproval": "needs_approval",
        "needs_approval": "needs_approval",
        "operator_approval": "needs_approval",
        "requires_approval": "needs_approval",
        "safe": "safe",
        "blocked": "blocked",
    }
    return lookup.get(normalized, normalized)


def normalize_incident_type(value: object) -> object:
    if not isinstance(value, str):
        return value
    normalized = value.strip().lower().replace(" ", "_").replace("-", "_")
    lookup = {
        "power": "power_outage",
        "outage": "power_outage",
        "power_outage": "power_outage",
        "power_outages": "power_outage",
        "traffic": "traffic_failure",
        "traffic_failure": "traffic_failure",
        "weather": "storm",
        "rain": "storm",
        "heavy_rain": "storm",
    }
    incident_type = lookup.get(normalized, normalized)
    valid = {
        "power_outage", "storm", "flood", "wildfire", "heatwave",
        "traffic_failure", "infrastructure", "other",
    }
    return incident_type if incident_type in valid else "other"


def normalize_text(value: object) -> object:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "; ".join(str(item) for item in value)
    if isinstance(value, dict):
        return "; ".join(f"{key}: {val}" for key, val in value.items())
    return value


def normalize_string_list(value: object) -> object:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [f"{key}: {val}" for key, val in value.items()]
    if isinstance(value, list):
        normalized: list[str] = []
        for item in value:
            if isinstance(item, str):
                normalized.append(item)
            elif isinstance(item, dict):
                normalized.append("; ".join(f"{key}: {val}" for key, val in item.items()))
            else:
                normalized.append(str(item))
        return normalized
    return value


def normalize_actions(value: object) -> object:
    if not isinstance(value, list):
        return value
    normalized_actions: list[object] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            normalized_actions.append(item)
            continue
        action = dict(item)
        recommended = action.pop("recommendedAction", None)
        if isinstance(recommended, dict):
            action = {**recommended, **action}
        action.setdefault("id", f"act-{index + 1:02d}")
        action["title"] = normalize_text(
            action.get("title")
            or action.get("name")
            or action.get("action")
            or f"Action {index + 1}"
        )
        action["description"] = normalize_text(
            action.get("description")
            or action.get("detail")
            or action.get("rationale")
            or action["title"]
        )
        action["tier"] = normalize_tier(
            action.get("tier") or action.get("safetyTier") or "needs_approval"
        )
        action["timeWindow"] = normalize_time_window(
            action.get("timeWindow") or action.get("phase") or action.get("window") or "immediate"
        )
        action["targetTeam"] = (
            action.get("targetTeam")
            or action.get("team")
            or action.get("owner")
            or "Operations"
        )
        action["dependsOn"] = normalize_string_list(action.get("dependsOn"))
        action["sourceFindings"] = normalize_string_list(
            action.get("sourceFindings")
            or action.get("sourceFinding")
            or action.get("findingId")
            or action.get("evidenceRefs")
        )
        normalized_actions.append(action)
    return normalized_actions


def time_phases_from_actions(actions: object) -> dict[str, list[str]]:
    phases = {"immediate": [], "shortTerm": [], "nextPeriod": []}
    if not isinstance(actions, list):
        return phases
    for item in actions:
        if not isinstance(item, dict):
            continue
        action_id = str(item.get("id") or item.get("title") or "action")
        window = normalize_time_window(item.get("timeWindow") or "immediate")
        if window == "short_term":
            phases["shortTerm"].append(action_id)
        elif window == "next_period":
            phases["nextPeriod"].append(action_id)
        else:
            phases["immediate"].append(action_id)
    return phases


def normalize_number(value: object) -> object:
    if isinstance(value, int | float):
        return value
    if isinstance(value, str):
        cleaned = value.strip().rstrip("%")
        try:
            return float(cleaned)
        except ValueError:
            return value
    if isinstance(value, dict):
        return first_number(value, ["value", "score", "riskScore", "confidence", "cityScore"])
    return value


def first_number(value: dict[str, object], keys: list[str]) -> object:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, int | float):
            return candidate
        if isinstance(candidate, str):
            try:
                return float(candidate)
            except ValueError:
                pass
    return value
