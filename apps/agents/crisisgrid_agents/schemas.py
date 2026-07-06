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
    def fill_decision(cls, value: object) -> object:
        if isinstance(value, dict) and "decision" not in value:
            value = {**value, "decision": value.get("rationale", "resolved")}
        return value

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


def normalize_time_window(value: object) -> object:
    if not isinstance(value, str):
        return value
    compact = value.replace("-", "_").replace(" ", "_")
    lookup = {
        "shortTerm": "short_term",
        "short_term": "short_term",
        "nextPeriod": "next_period",
        "next_period": "next_period",
    }
    return lookup.get(compact, compact)


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
        action["tier"] = action.get("tier") or action.get("safetyTier") or "needs_approval"
        action["timeWindow"] = action.get("timeWindow") or action.get("phase") or "immediate"
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
