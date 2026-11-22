// Cloudflare Access verification (ARCHITECTURE §3.1). Fails closed.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { apiClients, users } from "../db/schema";
import type { AppEnv, Principal } from "../env";
import { HttpError } from "./http";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(team: string) {
  let set = jwksCache.get(team);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, set);
  }
  return set;
}

interface AccessPayload extends JWTPayload {
  email?: string;
  common_name?: string;
  name?: string;
}

async function verifyAccess(token: string, team: string, aud: string): Promise<AccessPayload> {
  const { payload } = await jwtVerify(token, jwks(team), {
    issuer: `https://${team}`,
    audience: aud,
  });
  return payload as AccessPayload;
}

/** Resolve the caller. Sets c.var.principal or throws 401/403. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;
  const db = c.var.db;
  let email: string | null = null;
  let commonName: string | null = null;
  let displayName: string | null = null;

  if (env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
    const token =
      c.req.header("Cf-Access-Jwt-Assertion") ??
      getCookie(c.req.header("Cookie") ?? "", "CF_Authorization");
    if (!token) throw new HttpError(401, "Sign in through Cloudflare Access.");
    let payload: AccessPayload;
    try {
      payload = await verifyAccess(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    } catch {
      throw new HttpError(401, "Your sign-in has expired. Reload the page.");
    }
    if (payload.email) {
      email = payload.email.toLowerCase();
      displayName = typeof payload.name === "string" ? payload.name : null;
    } else if (payload.common_name) commonName = payload.common_name;
    else throw new HttpError(403, "Unrecognized Access identity.");
  } else if (env.DEV_AUTH_EMAIL) {
    // Local development: X-Dev-Client lets the smoke test act as a service token.
    const devClient = c.req.header("X-Dev-Client");
    if (devClient) commonName = devClient;
    else email = env.DEV_AUTH_EMAIL.toLowerCase();
  } else {
    throw new HttpError(503, "Access is not configured for this deployment.");
  }

  let principal: Principal;
  if (email) {
    let user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) {
      await db.insert(users).values({ email, name: displayName }).onConflictDoNothing();
      user = await db.query.users.findFirst({ where: eq(users.email, email) });
    }
    if (!user) throw new HttpError(500, "Could not create user.");
    principal = { kind: "user", userId: user.id, email: user.email, name: user.name };
  } else {
    const client = await db.query.apiClients.findFirst({
      where: eq(apiClients.clientId, commonName!),
    });
    if (!client || !client.active) {
      throw new HttpError(403, "This service token isn't registered in Greb Meals (Settings → API clients).");
    }
    principal = {
      kind: "client",
      clientDbId: client.id,
      name: client.name,
      scopes: client.scopes.split(",").map((s) => s.trim()).filter(Boolean),
    };
    // Best effort; don't block the request on it.
    c.executionCtx.waitUntil(
      db
        .update(apiClients)
        .set({ lastSeenAt: new Date().toISOString() })
        .where(eq(apiClients.id, client.id))
        .then(() => undefined, () => undefined),
    );
  }
  c.set("principal", principal);
  await next();
};

/** Users always pass. Clients need one of the scopes. */
export function allow(...scopes: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.var.principal;
    if (p.kind === "client" && !scopes.some((s) => p.scopes.includes(s))) {
      throw new HttpError(403, `This client needs the ${scopes.join(" or ")} scope.`);
    }
    await next();
  };
}

export function userId(p: Principal): number | null {
  return p.kind === "user" ? p.userId : null;
}

export function sourceName(p: Principal): string {
  return p.kind === "client" ? p.name : `user:${p.email}`;
}

function getCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
