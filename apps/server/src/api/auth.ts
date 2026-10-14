import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { httpJson } from "../lib/http.js";
import { unauthorized } from "../lib/errors.js";

export interface AuthUser {
  id: string;
  email: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}

/**
 * Verifies Supabase access tokens by asking Supabase Auth itself
 * (GET /auth/v1/user). This works for every signing-key configuration
 * (legacy HS256 secret or the newer asymmetric keys) without sharing secrets
 * with this service. Verified tokens are cached briefly.
 */
export function createAuth(cfg: Config) {
  const cache = new Map<string, { user: AuthUser; expiresAt: number }>();
  const TTL_MS = 5 * 60_000;

  async function verify(token: string): Promise<AuthUser> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.user;

    const res = await httpJson<{ id?: string; email?: string }>(`${cfg.SUPABASE_URL!.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: cfg.SUPABASE_ANON_KEY!, authorization: `Bearer ${token}` },
      retries: 1,
      timeoutMs: 10_000,
    });
    if (res.status !== 200 || !res.body?.id) throw unauthorized("Your session is invalid or has expired. Please sign in again.");
    const user: AuthUser = { id: res.body.id, email: res.body.email ?? null };
    let exp = Date.now() + TTL_MS;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
      if (payload.exp) exp = Math.min(exp, payload.exp * 1000);
    } catch {
      /* opaque token; keep default TTL */
    }
    cache.set(key, { user, expiresAt: exp });
    if (cache.size > 5000) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    }
    return user;
  }

  return async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
    if (cfg.AUTH_DISABLED) {
      req.user = { id: "local-dev", email: "dev@localhost" };
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw unauthorized("Sign in to continue.");
    req.user = await verify(token);
  };
}
