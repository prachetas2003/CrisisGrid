#!/bin/bash
set -euo pipefail

# Railway (and similar) inject PORT — Fastify listens on it and serves both
# /api/* and the built React app. Agents stay on an internal localhost port.
export PORT=${PORT:-${WEB_PORT:-8080}}
export SERVER_PORT=${PORT}
export AGENTS_PORT=${AGENTS_PORT:-8090}
export DATABASE_PATH=${DATABASE_PATH:-/app/data/crisisgrid.sqlite}
export AGENTS_URL=${AGENTS_URL:-http://127.0.0.1:${AGENTS_PORT}}
export DEMO_MODE=${DEMO_MODE:-true}

mkdir -p "$(dirname "$DATABASE_PATH")"

log() {
  echo "[crisisgrid] $*"
}

log "container boot"
log "  PORT=$PORT (Fastify public — API + static UI)"
log "  AGENTS_PORT=$AGENTS_PORT (internal)"
log "  DATABASE_PATH=$DATABASE_PATH"
log "  DEMO_MODE=$DEMO_MODE"
log "  GOOGLE_API_KEY=${GOOGLE_API_KEY:+set}${GOOGLE_API_KEY:-MISSING — live runs will fail}"

if [ ! -f /app/apps/web/dist/index.html ]; then
  log "ERROR: missing /app/apps/web/dist/index.html — Docker build did not produce the web UI"
  exit 1
fi

if [ ! -f /app/scenarios/westside-cascade/meta.json ]; then
  log "ERROR: missing scenario files under /app/scenarios/westside-cascade"
  exit 1
fi

pipe_logs() {
  local tag=$1
  while IFS= read -r line; do
    echo "[$tag] $line"
  done
}

# Optional: Python agent service (live assessment). Replay mode works without it.
log "starting agent service..."
(
  cd /app/apps/agents
  /app/apps/agents/.venv/bin/python -m crisisgrid_agents.main
) 2>&1 | pipe_logs agents &

# Main process: Fastify on $PORT — this is what Railway's public edge must hit.
log "starting Fastify on 0.0.0.0:$PORT..."
cd /app
exec pnpm --filter @crisisgrid/server start
