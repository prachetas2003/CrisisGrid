"""Service configuration. No secrets here — GOOGLE_API_KEY comes from env."""
from __future__ import annotations

import os
from pathlib import Path

# .../apps/agents/crisisgrid_agents/config.py -> repo root is 3 levels up
REPO_ROOT = Path(__file__).resolve().parents[3]

# Gemini models (plan/04 §4): Flash for domain agents, Pro for the Commander.
FLASH_MODEL = os.environ.get("CRISISGRID_FLASH_MODEL", "gemini-2.5-flash")
PRO_MODEL = os.environ.get("CRISISGRID_PRO_MODEL", "gemini-2.5-pro")

DEFAULT_SCENARIO = "westside-cascade"
MAX_CRITIQUE_LOOPS = 3
AGENTS_PORT = int(os.environ.get("AGENTS_PORT", "8090"))
AGENT_CALL_TIMEOUT_SECONDS = int(os.environ.get("AGENT_CALL_TIMEOUT_SECONDS", "90"))


def mcp_server_command() -> tuple[str, list[str]]:
    """Command that spawns the CrisisGrid MCP server over stdio.

    The MCP server is the ONLY data path for agents (eval 13): this module
    deliberately contains no HTTP client for city data.
    """
    entry = str(REPO_ROOT / "packages" / "mcp-server" / "src" / "index.ts")
    tsx = str(REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs")
    return "node", [tsx, entry]
