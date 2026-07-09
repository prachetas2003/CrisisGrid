import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Load the repo-root .env so SERVER_PORT is consistent across all services
// (this was the 8080-vs-18080 mismatch that silently broke the old UI).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = join(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = t.slice(i + 1).trim();
  }
}

const apiPort = Number(process.env.SERVER_PORT ?? 8080);
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiProxy = {
  "/api": {
    target: `http://127.0.0.1:${apiPort}`,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: webPort,
    proxy: apiProxy,
  },
  preview: {
    host: true,
    port: webPort,
    // Railway/Render assign a public hostname; Vite preview blocks unknown hosts by default.
    allowedHosts: true,
    // Required for Docker monolith: preview serves the built UI and proxies /api → Fastify.
    proxy: apiProxy,
  },
});
