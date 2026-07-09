#!/bin/bash
set -euo pipefail

# Hosting platforms (Railway, Render, Fly) inject PORT — map it to the public web port.
export WEB_PORT=${PORT:-${WEB_PORT:-5173}}
export SERVER_PORT=${SERVER_PORT:-18080}
export AGENTS_PORT=${AGENTS_PORT:-8090}
export DATABASE_PATH=${DATABASE_PATH:-/app/data/crisisgrid.sqlite}
export AGENTS_URL=${AGENTS_URL:-http://127.0.0.1:${AGENTS_PORT}}
export SERVER_URL=${SERVER_URL:-http://127.0.0.1:${SERVER_PORT}}

# Never let the internal API bind the same port as the public web server.
if [ "$SERVER_PORT" = "$WEB_PORT" ]; then
  export SERVER_PORT=18080
fi

mkdir -p "$(dirname "$DATABASE_PATH")"

log() {
  echo "[crisisgrid] $*"
}

log "container boot"
log "  WEB_PORT=$WEB_PORT (public)"
log "  SERVER_PORT=$SERVER_PORT (internal API)"
log "  AGENTS_PORT=$AGENTS_PORT"
log "  GOOGLE_API_KEY=${GOOGLE_API_KEY:+set}${GOOGLE_API_KEY:-MISSING — live runs will fail}"

# Prefix subprocess logs so Railway captures them (background jobs are otherwise silent).
pipe_logs() {
  local tag=$1
  while IFS= read -r line; do
    echo "[$tag] $line"
  done
}

# 1. Python agent service (localhost only — server calls it internally)
log "starting agent service..."
(
  cd /app/apps/agents
  /app/apps/agents/.venv/bin/python -m crisisgrid_agents.main
) 2>&1 | pipe_logs agents &
AGENTS_PID=$!

# 2. Fastify API + scenario engine
log "starting API server..."
(
  cd /app
  pnpm --filter @crisisgrid/server start
) 2>&1 | pipe_logs server &
SERVER_PID=$!

wait_for_server() {
  local url="http://127.0.0.1:${SERVER_PORT}/api/health"
  for _ in $(seq 1 45); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log "API server ready at $url"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "ERROR: API server exited before becoming ready — check [server] logs above"
      return 1
    fi
    sleep 1
  done
  log "ERROR: API server did not respond within 45s at $url"
  return 1
}

if ! wait_for_server; then
  exit 1
fi

# 3. Vite preview — serves built React app and proxies /api → SERVER_PORT
log "starting web UI on 0.0.0.0:$WEB_PORT..."
exec pnpm --filter @crisisgrid/web preview --host 0.0.0.0 --port "$WEB_PORT"
