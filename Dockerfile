# Base image with Python 3.11
FROM python:3.11-bullseye

# Node 22 (built-in node:sqlite — no native better-sqlite3 binary needed in Docker)
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      gnupg \
      build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && node --version \
    && npm --version \
    && npm install -g pnpm \
    && pnpm --version \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Copy lock files and workspace configs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/engine/package.json ./packages/engine/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY packages/cli/package.json ./packages/cli/

# Install Node.js dependencies (allow better-sqlite3 native build for non-Docker dev)
RUN pnpm install --frozen-lockfile \
    && pnpm rebuild better-sqlite3

# Copy the rest of the application
COPY . .

# Set up Python virtual environment
RUN python -m venv /app/apps/agents/.venv && \
    /app/apps/agents/.venv/bin/pip install --upgrade pip && \
    /app/apps/agents/.venv/bin/pip install google-adk mcp fastapi "uvicorn[standard]" httpx pydantic

# Build all TypeScript projects and Vite application
RUN pnpm build

# Writable SQLite path for container runtime
RUN mkdir -p /app/data

# Expose the public web port (platforms map $PORT here via start.sh)
EXPOSE 5173

# Make start.sh executable
RUN chmod +x /app/start.sh

# Run start script
CMD ["/app/start.sh"]
