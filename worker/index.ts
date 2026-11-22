import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { AppEnv } from "./env";
import { authenticate } from "./lib/auth";
import { HttpError } from "./lib/http";
import recipesRoutes from "./routes/recipes";
import plansRoutes from "./routes/plans";
import listsRoutes from "./routes/lists";
import ingestRoutes from "./routes/ingest";
import { calendar, ha } from "./routes/integrations";

const api = new Hono<AppEnv>().basePath("/api");

api.use("*", async (c, next) => {
  c.set("db", drizzle(c.env.DB, { schema }));
  await next();
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});

api.get("/health", (c) => c.json({ ok: true }));

// Calendar feed: token in the URL, behind an Access Bypass app (calendar apps can't send headers).
api.route("/", calendar);

api.use("*", authenticate);

/**
 * Service tokens only reach the integration and ingest endpoints, plus GETs with the read scope.
 * Users reach everything.
 */
api.use("*", async (c, next) => {
  const p = c.var.principal;
  if (p.kind === "client") {
    const path = c.req.path;
    const ok =
      path.startsWith("/api/ha/") ||
      (path.startsWith("/api/ingest/") && path !== "/api/ingest/runs") ||
      (c.req.method === "GET" && p.scopes.includes("read") && !path.startsWith("/api/clients") && !path.startsWith("/api/feed-tokens"));
    if (!ok) throw new HttpError(403, "This service token can't use that endpoint.");
  }
  await next();
});

api.get("/me", (c) => {
  const p = c.var.principal;
  return c.json(p.kind === "user" ? { kind: "user", email: p.email, name: p.name } : { kind: "client", name: p.name, scopes: p.scopes });
});

api.route("/", recipesRoutes);
api.route("/", plansRoutes);
api.route("/", listsRoutes);
api.route("/", ingestRoutes);
api.route("/", ha);

api.notFound((c) => c.json({ error: "Not found" }, 404));

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: "Body is not valid JSON" }, 400);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

export default {
  fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return api.fetch(req, env, ctx);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;
