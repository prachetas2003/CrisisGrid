import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";

export type AuthRole = "viewer" | "operator" | "admin";

export interface Principal {
  name: string;
  role: AuthRole;
  tokenId: string;
}

export interface AuthStatus {
  mode: "open-dev" | "api-key";
  configured: boolean;
  roles: AuthRole[];
  note: string;
}

const ROLE_RANK: Record<AuthRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

interface ApiKeyEntry {
  token: string;
  role: AuthRole;
  name: string;
}

export function authStatus(): AuthStatus {
  const configured = hasKeyConfig();
  const keys = configuredKeys();
  if (configured && !keys.length) {
    return {
      mode: "api-key",
      configured: false,
      roles: [],
      note: "CRISISGRID_API_KEYS is set but contains no valid entries; mutating requests are rejected.",
    };
  }
  if (!keys.length) {
    return {
      mode: "open-dev",
      configured: false,
      roles: ["admin"],
      note: "No API keys configured; local development allows mutating requests.",
    };
  }
  return {
    mode: "api-key",
    configured: true,
    roles: [...new Set(keys.map((key) => key.role))],
    note: "Mutating requests require Authorization: Bearer <token> or x-api-key.",
  };
}

export function requireRole(required: AuthRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticate(req);
    if (!principal) {
      return reply.code(401).send({
        error: "unauthorized",
        requiredRole: required,
        hint: "Send Authorization: Bearer <token> or x-api-key.",
      });
    }
    if (ROLE_RANK[principal.role] < ROLE_RANK[required]) {
      return reply.code(403).send({
        error: "forbidden",
        requiredRole: required,
        role: principal.role,
      });
    }
  };
}

export function currentPrincipal(req: FastifyRequest): Principal {
  return authenticate(req) ?? devPrincipal();
}

function authenticate(req: FastifyRequest): Principal | null {
  const keys = configuredKeys();
  if (!keys.length) return hasKeyConfig() ? null : devPrincipal();

  const token = bearerToken(req.headers.authorization) ?? headerValue(req.headers["x-api-key"]);
  if (!token) return null;
  const entry = keys.find((key) => constantTimeEqual(key.token, token));
  if (!entry) return null;
  return {
    name: entry.name,
    role: entry.role,
    tokenId: digestToken(entry.token),
  };
}

function configuredKeys(): ApiKeyEntry[] {
  const raw = process.env.CRISISGRID_API_KEYS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseKey)
    .filter((entry): entry is ApiKeyEntry => Boolean(entry));
}

function hasKeyConfig(): boolean {
  return Boolean(process.env.CRISISGRID_API_KEYS?.trim());
}

function parseKey(part: string): ApiKeyEntry | null {
  const [roleOrName, maybeRole, maybeToken] = part.split(":");
  if (maybeToken) {
    const role = parseRole(maybeRole);
    if (!role) return null;
    return { name: roleOrName || role, role, token: maybeToken };
  }

  const [roleRaw, token] = part.split("=");
  const role = parseRole(roleRaw);
  if (!role || !token) return null;
  return { name: role, role, token };
}

function parseRole(value: string | undefined): AuthRole | null {
  if (value === "viewer" || value === "operator" || value === "admin") return value;
  return null;
}

function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const [scheme, token] = value.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function devPrincipal(): Principal {
  return { name: "dev-anonymous", role: "admin", tokenId: "open-dev" };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
