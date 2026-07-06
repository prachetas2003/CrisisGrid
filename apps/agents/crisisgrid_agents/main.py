"""FastAPI wrapper: POST /run streams pipeline events as NDJSON.

The Node orchestration server is the only intended caller; it persists
events (findings, plans, debate turns) and re-broadcasts them over SSE.
"""
from __future__ import annotations

import json
import os

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import config
from .agents import TOOL_SCOPES, make_toolset
from .pipeline import run_assessment

app = FastAPI(title="CrisisGrid Agent Service", version="0.2.0")


class RunRequest(BaseModel):
    operatorText: str
    scenarioId: str = config.DEFAULT_SCENARIO
    incidentId: str | None = None


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "crisisgrid-agents",
        "llmConfigured": bool(os.environ.get("GOOGLE_API_KEY")),
        "models": {"flash": config.FLASH_MODEL, "pro": config.PRO_MODEL},
    }


@app.get("/tools")
async def tools() -> dict:
    """Verify MCP connectivity without an LLM call: spawn the MCP server and list tools."""
    toolset = make_toolset(tool_filter=[])
    try:
        listed = await toolset.get_tools()
        return {"ok": True, "count": len(listed), "tools": sorted(t.name for t in listed)}
    finally:
        await toolset.close()


@app.get("/scopes")
async def scopes() -> dict:
    return {"scopes": TOOL_SCOPES}


@app.post("/run")
async def run(req: RunRequest) -> StreamingResponse:
    async def stream():
        async for event in run_assessment(req.operatorText, req.scenarioId, req.incidentId):
            yield json.dumps(event) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


def serve() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=config.AGENTS_PORT)


if __name__ == "__main__":
    serve()
