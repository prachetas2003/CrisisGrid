# Node comes from the official image (no apt / NodeSource — those fail on Render).
FROM node:22-bookworm AS node

FROM python:3.11-bookworm

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g pnpm@9 \
 && node --version \
 && pnpm --version

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/engine/package.json ./packages/engine/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/cli/package.json ./packages/cli/

# Skip native better-sqlite3 build — runtime uses Node 22 built-in node:sqlite
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN python -m venv /app/apps/agents/.venv && \
    /app/apps/agents/.venv/bin/pip install --upgrade pip && \
    /app/apps/agents/.venv/bin/pip install google-adk mcp fastapi "uvicorn[standard]" httpx pydantic

RUN pnpm build

RUN mkdir -p /app/data

EXPOSE 8080

RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
