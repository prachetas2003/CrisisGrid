#!/bin/bash
set -e

# Hosting platforms (Railway, Render, Fly) inject PORT — map it to the public web port.
export WEB_PORT=${PORT:-${WEB_PORT:-5173}}
export SERVER_PORT=${SERVER_PORT:-18080}
export AGENTS_PORT=${AGENTS_PORT:-8090}
export DATABASE_PATH=${DATABASE_PATH:-/app/data/crisisgrid.sqlite}
export AGENTS_URL=${AGENTS_URL:-http://127.0.0.1:${AGENTS_PORT}}
export SERVER_URL=${SERVER_URL:-http://127.0.0.1:${SERVER_PORT}}

mkdir -p "$(dirname "$DATABASE_PATH")"

echo "CrisisGrid container boot"
echo "  WEB_PORT=$WEB_PORT (public)"
echo "  SERVER_PORT=$SERVER_PORT"
echo "  AGENTS_PORT=$AGENTS_PORT"
echo "  GOOGLE_API_KEY=${GOOGLE_API_KEY:+set}${GOOGLE_API_KEY:-MISSING — live runs will fail}"

# 1. Python agent service (localhost only — server calls it internally)
echo "Starting agent service..."
(
  cd /app/apps/agents
  /app/apps/agents/.venv/bin/python -m crisisgrid_agents.main
) &
AGENTS_PID=$!

# 2. Fastify API + scenario engine
echo "Starting API server..."
pnpm --filter @crisisgrid/server start &
SERVER_PID=$!

# Give backend a moment to bind before the UI starts proxying /api
sleep 2

# 3. Vite preview — serves built React app and proxies /api → SERVER_PORT
echo "Starting web UI on 0.0.0.0:$WEB_PORT..."
exec pnpm --filter @crisisgrid/web preview --host 0.0.0.0 --port "$WEB_PORT"
