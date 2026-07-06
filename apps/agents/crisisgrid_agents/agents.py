"""Agent definitions (plan/04-agents.md).

Each agent is an ADK LlmAgent with a filtered view of the shared MCP toolset
— tool scoping is structural (an agent literally does not have the tool),
not prompt-based. Nobody gets comms_send_sandbox_alert or safety_record_approval:
publishing and approving are operator actions.
"""
from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool.mcp_session_manager import (
    StdioConnectionParams,
    StdioServerParameters,
)
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset

from . import config, prompts

# Dotted names from packages/mcp-server/src/registry.ts, underscored for MCP.
TOOL_SCOPES: dict[str, list[str]] = {
    "intake": ["geo_geocode", "grid_get_outages", "geo_get_zone_boundaries"],
    "weather": [
        "weather_get_forecast", "weather_get_alerts", "weather_get_rainfall_risk",
        "weather_get_wind_risk", "traffic_find_routes", "geo_get_zone_boundaries",
    ],
    "power": [
        "grid_get_outages", "grid_get_affected_zones", "grid_get_critical_facilities",
        "grid_estimate_restoration_priority", "geo_find_nearby_facilities",
    ],
    "traffic": [
        "traffic_get_congestion", "traffic_get_road_closures", "traffic_find_routes",
        "traffic_estimate_evacuation_time", "geo_get_zone_boundaries",
    ],
    "shelter": [
        "shelters_list", "shelters_get_capacity", "resources_get_available_units",
        "resources_recommend_staging", "geo_get_zone_boundaries", "geo_find_nearby_facilities",
        "geo_calculate_distance",
    ],
    "commander": ["geo_overlay_risk_layers", "sim_compare_response_plans"],
    "safety": ["safety_evaluate_action", "audit_log_event"],
    "comms": ["comms_draft_public_alert", "comms_draft_internal_update"],
    "briefing": [],
}


def make_toolset(tool_filter: list[str]) -> McpToolset:
    command, args = config.mcp_server_command()
    return McpToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(command=command, args=args, cwd=config.REPO_ROOT),
        ),
        tool_filter=tool_filter,
    )


def _agent(agent_id: str, model: str, instruction: str) -> LlmAgent:
    scope = TOOL_SCOPES[agent_id]
    return LlmAgent(
        name=f"crisisgrid_{agent_id}",
        model=model,
        instruction=instruction,
        tools=[make_toolset(scope)] if scope else [],
    )


def build_intake() -> LlmAgent:
    return _agent("intake", config.FLASH_MODEL, prompts.INTAKE)


def build_domain_agents() -> dict[str, LlmAgent]:
    return {
        "weather": _agent("weather", config.FLASH_MODEL, prompts.WEATHER),
        "power": _agent("power", config.FLASH_MODEL, prompts.POWER),
        "traffic": _agent("traffic", config.FLASH_MODEL, prompts.TRAFFIC),
        "shelter": _agent("shelter", config.FLASH_MODEL, prompts.SHELTER),
    }


def build_debater(agent_id: str) -> LlmAgent:
    # Debaters reuse their domain tool scope so they can pull fresh evidence.
    scope_id = agent_id if agent_id in TOOL_SCOPES else "weather"
    instruction = f"""
You are the CrisisGrid {agent_id} debate agent. The user message gives you the conflict id,
your agent id, the other agent id, your finding, and their finding. Copy those ids exactly.

Decide one stance:
- confirm: the other agent's concern does not change your finding.
- contest: your evidence outweighs theirs.
- amend: update your finding and provide a full amendedFinding object.

Respond with ONLY this JSON object shape:
{{"conflictId":"<copy from user message>","round":1,"fromAgent":"{agent_id}",
"toAgent":"<other agent id>","stance":"confirm|contest|amend",
"text":"<2-3 sentences citing evidence>","evidenceRefs":["<toolCallId or finding id>"],
"amendedFinding":null}}
"""
    return LlmAgent(
        name=f"crisisgrid_{agent_id}_debate",
        model=config.FLASH_MODEL,
        instruction=instruction,
        tools=[make_toolset(TOOL_SCOPES[scope_id])] if TOOL_SCOPES[scope_id] else [],
    )


def build_commander() -> LlmAgent:
    return _agent("commander", config.PRO_MODEL, prompts.COMMANDER)


def build_safety() -> LlmAgent:
    return _agent("safety", config.FLASH_MODEL, prompts.SAFETY)


def build_comms() -> LlmAgent:
    return _agent("comms", config.FLASH_MODEL, prompts.COMMS)


def build_briefing() -> LlmAgent:
    return _agent("briefing", config.FLASH_MODEL, prompts.BRIEFING)
