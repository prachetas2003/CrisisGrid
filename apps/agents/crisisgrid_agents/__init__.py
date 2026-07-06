"""CrisisGrid agent service — Google ADK multi-agent crisis assessment.

Nine specialized agents (plan/04-agents.md) collaborate in four phases:
parallel assessment -> deterministic conflict detection -> debate ->
commander synthesis with a safety critique loop. All data access goes
through the CrisisGrid MCP server; agents hold no API clients and no
approval tokens.
"""
