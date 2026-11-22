// Home Assistant, calendar feed, and machine-client management (ARCHITECTURE §3.1, §9).
import { Hono } from "hono";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { apiClients, feedTokens, mealPlans, planEntries, recipes } from "../db/schema";
import type { AppEnv, DB } from "../env";
import { allow, randomToken, sha256Hex } from "../lib/auth";
import { addDays, todayIn } from "../lib/dates";
import { bad, HttpError, idParam, notFound, obj, optBool, optStr, str } from "../lib/http";
import { buildIcs } from "../lib/ics";

const SCOPES = ["ha", "ingest", "read"];

async function dinners(db: DB, start: string, end: string) {
  return db
    .select({
      date: planEntries.date,
      recipe_id: planEntries.recipeId,
      title: recipes.title,
      freeform: planEntries.freeformText,
      prep_note: recipes.prepNote,
      notes: planEntries.notes,
      updated_at: mealPlans.updatedAt,
    })
    .from(planEntries)
    .innerJoin(mealPlans, eq(mealPlans.id, planEntries.planId))
    .leftJoin(recipes, eq(recipes.id, planEntries.recipeId))
    .where(
      and(
        eq(mealPlans.status, "active"),
        eq(planEntries.slot, "dinner"),
        gte(planEntries.date, start),
        lte(planEntries.date, end),
      ),
    )
    .orderBy(asc(planEntries.date));
}

type DinnerRow = Awaited<ReturnType<typeof dinners>>[number];

function dinnerOut(date: string, row: DinnerRow | undefined) {
  return {
    date,
    dinner: row?.title ?? row?.freeform ?? null,
    recipe_id: row?.recipe_id ?? null,
    freeform: row?.freeform ?? null,
    prep_note: row?.prep_note ?? null,
    notes: row?.notes ?? null,
  };
}

// ------------------------------------------------------------ authenticated (Access)

export const ha = new Hono<AppEnv>();

ha.get("/ha/today", allow("ha", "read"), async (c) => {
  const today = todayIn(c.env.APP_TZ || "America/Chicago");
  const tomorrow = addDays(today, 1);
  const rows = await dinners(c.var.db, today, tomorrow);
  return c.json({
    ...dinnerOut(today, rows.find((r) => r.date === today)),
    tomorrow: dinnerOut(tomorrow, rows.find((r) => r.date === tomorrow)),
  });
});

ha.get("/ha/week", allow("ha", "read"), async (c) => {
  const today = todayIn(c.env.APP_TZ || "America/Chicago");
  const end = addDays(today, 6);
  const rows = await dinners(c.var.db, today, end);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  return c.json(days.map((d) => dinnerOut(d, rows.find((r) => r.date === d))));
});

// --- API clients (service tokens). Users only.
ha.get("/clients", async (c) => {
  const rows = await c.var.db.select().from(apiClients).orderBy(asc(apiClients.name));
  return c.json(rows.map(clientOut));
});

function clientOut(r: typeof apiClients.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    client_id: r.clientId,
    scopes: r.scopes.split(",").filter(Boolean),
    active: r.active,
    created_at: r.createdAt,
    last_seen_at: r.lastSeenAt,
  };
}

function readScopes(v: unknown): string {
  if (!Array.isArray(v) || !v.length) bad("Pick at least one scope");
  const s = [...new Set(v.map(String))];
  for (const x of s) if (!SCOPES.includes(x)) bad(`Unknown scope ${x}`);
  return s.join(",");
}

ha.post("/clients", async (c) => {
  const o = obj(await c.req.json());
  const clientId = str(o, "client_id", { max: 100 });
  if (!/^[A-Za-z0-9._-]+$/.test(clientId)) bad("That doesn't look like an Access Client ID");
  try {
    const [row] = await c.var.db
      .insert(apiClients)
      .values({ name: str(o, "name", { max: 60 }), clientId, scopes: readScopes(o.scopes) })
      .returning();
    return c.json(clientOut(row), 201);
  } catch (e) {
    if (String(e).includes("UNIQUE")) bad("A client with that name or Client ID already exists");
    throw e;
  }
});

ha.put("/clients/:id", async (c) => {
  const o = obj(await c.req.json());
  const set: Partial<typeof apiClients.$inferInsert> = {};
  const name = optStr(o, "name", { max: 60 });
  if (name) set.name = name;
  if (o.scopes !== undefined) set.scopes = readScopes(o.scopes);
  const active = optBool(o, "active");
  if (active !== undefined) set.active = active;
  const [row] = await c.var.db.update(apiClients).set(set).where(eq(apiClients.id, idParam(c.req.param("id")))).returning();
  if (!row) notFound();
  return c.json(clientOut(row));
});

ha.delete("/clients/:id", async (c) => {
  await c.var.db.delete(apiClients).where(eq(apiClients.id, idParam(c.req.param("id"))));
  return c.json({ ok: true });
});

// --- Calendar feed tokens. Users only.
ha.get("/feed-tokens", async (c) => {
  const rows = await c.var.db.select().from(feedTokens).orderBy(desc(feedTokens.createdAt));
  return c.json(
    rows.map((r) => ({ id: r.id, name: r.name, created_at: r.createdAt, last_used_at: r.lastUsedAt, revoked: r.revoked })),
  );
});

ha.post("/feed-tokens", async (c) => {
  const o = obj(await c.req.json());
  const token = randomToken();
  const [row] = await c.var.db
    .insert(feedTokens)
    .values({ name: str(o, "name", { max: 60 }), tokenHash: await sha256Hex(token) })
    .returning();
  const url = new URL(c.req.url);
  // The token is shown once; only its hash is stored.
  return c.json({ id: row.id, name: row.name, token, url: `${url.origin}/api/calendar.ics?token=${token}` }, 201);
});

ha.delete("/feed-tokens/:id", async (c) => {
  await c.var.db.update(feedTokens).set({ revoked: true }).where(eq(feedTokens.id, idParam(c.req.param("id"))));
  return c.json({ ok: true });
});

// ------------------------------------------------------------ public (token in URL)

export const calendar = new Hono<AppEnv>();

calendar.get("/calendar.ics", async (c) => {
  const token = c.req.query("token");
  if (!token) throw new HttpError(401, "Missing token");
  const db = c.var.db;
  const row = await db.query.feedTokens.findFirst({ where: eq(feedTokens.tokenHash, await sha256Hex(token)) });
  if (!row || row.revoked) throw new HttpError(401, "Invalid token");
  c.executionCtx.waitUntil(
    db
      .update(feedTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(feedTokens.id, row.id))
      .then(() => undefined, () => undefined),
  );
  const today = todayIn(c.env.APP_TZ || "America/Chicago");
  const rows = await dinners(db, addDays(today, -31), addDays(today, 62));
  const origin = new URL(c.req.url).origin;
  const ics = buildIcs(
    "Dinner",
    rows
      .filter((r) => r.title || r.freeform)
      .map((r) => ({
        uid: `dinner-${r.date}@meals.greb.party`,
        date: r.date,
        summary: r.title ?? r.freeform ?? "",
        description: [r.prep_note, r.notes].filter(Boolean).join("\n") || null,
        url: r.recipe_id ? `${origin}/recipes/${r.recipe_id}` : null,
      })),
  );
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Cache-Control": "private, max-age=300",
  });
});
