# CrisisGrid — AI Crisis Command Center

> Describe a city crisis in plain English — watch **nine AI agents** investigate live data, argue about the risks, and hand you an approvable action plan where **every number traces to a tool call**.

Built for Google's agentic AI hackathon: Google ADK agents (Gemini), a 40-tool MCP server as the agents' *only* data path, structural (not prompt-based) safety tiers, a deterministic forkable city simulation, and 47 automated evals.

---

## 🗺 System Architecture

CrisisGrid is a multi-agent orchestration system composed of three key layers:
1. **React Web Command Center (`apps/web`):** Rich, interactive MapLibre UI displaying evacuation corridors, zones, substation/shelter/hospital nodes, live telemetry logs, and a phone simulation.
2. **Fastify Orchestration Server (`apps/server`):** Coordinates incidents, action queues, audit logs, and sqlite state, streaming telemetry via Server-Sent Events (SSE).
3. **Python ADK Agent Service (`apps/agents`):** Powered by the Google ADK, hosting 9 specialized Gemini agents coordinating in a 4-phase safety pipeline.

```
React Web Command Center (Vite)  ──SSE / NDJSON──▶ Live Telemetry & Inspector
             │
Fastify Orchestration Server (TS) ── Scenario Engine · Action Queue · SQLite DB
             │
Python ADK Agent Service (9 Gemini Agents)
             └──── MCP over stdio ────▶ MCP server (TS): 40 tools, 3 safety tiers
                                        (The ONLY data path for agents)
```

---

## 🛠 Local Development Setup

### 1. Prereqs
Make sure you have Node.js 20+ and Python 3.11+ installed.

### 2. Node.js Installation
From the root of the directory, run:
```bash
pnpm install
```

### 3. Python Virtual Environment Setup
Configure your virtual environment and install the required ADK dependencies:

**For Windows (PowerShell):**
```powershell
python -m venv apps/agents/.venv
apps/agents/.venv/Scripts/pip install --upgrade pip
apps/agents/.venv/Scripts/pip install google-adk mcp fastapi "uvicorn[standard]" httpx pydantic
```

**For macOS / Linux:**
```bash
python3 -m venv apps/agents/.venv
source apps/agents/.venv/bin/activate
pip install --upgrade pip
pip install google-adk mcp fastapi "uvicorn[standard]" httpx pydantic
```

### 4. Configure Environment
Create a `.env` file in the project root:
```env
GOOGLE_API_KEY=your_gemini_api_key_here
DATABASE_PATH=db.sqlite
SERVER_PORT=18080
AGENTS_PORT=8090
WEB_PORT=5173
```

### 5. Boot Up the Command Center
Run the following to spin up the API server, agent service, and Vite web app concurrently:
```bash
pnpm dev
```
Open **http://localhost:5173** to access the dashboard.

---

## ⏱ The 90-Second Demo Script

This script walks through all key features of the application quickly for presentation:

1. **(0:00) Command Center:** Look at the dark basemap. Westbank and Cedar Heights are colored red (power outage). Riverbend General Hospital is pulsing with "Backup power — 8h remaining." Click any element to see its plain-language inspector.
2. **(0:15) Type the Crisis:** The prompt is pre-filled: *"Storm knocked out power in Cedar Heights and Westbank, heavy rain is coming, and Riverbend General Hospital is on backup generators. What should we do?"* Click **Run live assessment**.
3. **(0:20) Agent Room:** Watch the 9 agent tiles light up. The domain analysts (Weather, Power, Traffic, Shelter) check their respective telemetry in parallel. Findings appear in the live feed as cards.
4. **(0:45) Agent Debate:** Watch the deterministic conflict manager catch a contradiction (e.g., Shelter plans a shelter in a zone Power flagged as blacked out). The agents debate using evidence, objection, and amendments until the Commander synthesizes a ruling.
5. **(1:05) Safety Critique Loop:** The Safety agent performs structured reviews, forcing the commander to revise the plan until it satisfies safety guidelines.
6. **(1:20) Your Decisions:** The actions enqueued by the agents are presented for human-in-the-loop approval. Approve the SMS Alert to see it display instantly on the simulated phone mockup.
7. **(1:30) Judge Mode (Top Right):** Open the slide-out drawer to demonstrate the 40-tool MCP catalog, safety tiers, and the 47 automated test summaries.

---

## 🚀 Production Deployment

Deploying multi-agent services requires bundling Node.js (for orchestrator and MCP tool handlers) and Python (for agent logic) into the same environment. We recommend **Option A: Container Monolith** as the simplest and most robust strategy for hackathons.

### Option A: Single-Container Monolith (Recommended)
This approach runs all three services (Fastify, Python Agents, and Vite Static Preview) inside a single container on localhost, completely eliminating CORS configuration and inter-service authentication overhead.

We have included a production-ready `Dockerfile` and `start.sh` in the repository root.

#### Deployment Steps:
1. **Host Configuration:** Deploy to a container hosting provider that supports Docker builds (e.g., **Railway**, **Render**, **Fly.io**, or **AWS ECS**).
2. **Environment Variables:** Define the following variables on your host:
   - `GOOGLE_API_KEY`: Your Gemini API key.
   - `PORT`: Change to expose port `5173` (the frontend port).
3. **Build:** Let the host build and launch via the root `Dockerfile`.

### Option B: Split Services
If you prefer splitting services, you must deploy:
* **Frontend:** Build `apps/web` (`pnpm build`) and serve static assets via **Vercel**, **Netlify**, or **Cloudflare Pages**.
* **Orchestration Server:** Deploy `apps/server` to **Railway** or **Render** (Node.js runtime).
* **Agent Service:** Deploy `apps/agents` to **Railway** or **Render** (Python runtime). **Important:** Since the Python agent service launches the MCP server via `node` (stdio), Node.js *must* be installed on the machine running your Python agent service.

---

## 🧪 Automated Evaluations

We maintain **47 unit and integration tests** verifying system determinism, geographical geometry parsing, policy tier enforcement, HMAC single-use approval gates, and agent integrity constraints.

Run the test suite from the repository root:
```bash
pnpm evals
```

---

## 📁 Repository Map

| Workspace Path | Purpose |
|---|---|
| `apps/web` | React + Zustand Command Center (MapLibre vector maps & SSE event stream) |
| `apps/server` | Fastify backend: orchestrates SQLite DB, enqueues actions, hosts audit chains |
| `apps/agents` | Python ADK agent service: orchestrates intake, domain analysts, and synthesis |
| `packages/mcp-server` | MCP stdio server: 40 tools across 10 domains enforcing strict safety gates |
| `packages/engine` | Deterministic scenario simulation engine supporting what-if timelines |
| `packages/shared` | Zod schemas, policy rules, and cryptographic approval handlers |
| `packages/cli` | Command Line Interface supporting manual assessment, triggers, and reports |
| `scenarios/westside-cascade` | Portland-area scenario configuration: 16 neighborhoods, floodplain bounds |
| `evals/ts` | 47 Vitest evaluations |
