import { Hono } from "hono";
import { and, asc, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import {
  aisles,
  ingredients,
  mealPlans,
  planEntries,
  recipeIngredients,
  recipes,
  shoppingItems,
  shoppingLists,
} from "../db/schema";
import type { AppEnv, DB } from "../env";
import { aggregate, itemKey, type AggLine } from "../lib/aggregate";
import { addDays, daysBetween, isDate, todayIn } from "../lib/dates";
import { bad, chunk, idParam, notFound, obj, optBool, optNum, optStr, str } from "../lib/http";
import { normalizeUnit } from "../lib/units";

const app = new Hono<AppEnv>();

async function buildItems(db: DB, start: string, end: string, includeStaples: boolean) {
  const rows = await db
    .select({
      entryId: planEntries.id,
      servingsOverride: planEntries.servingsOverride,
      servings: recipes.servings,
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      isStaple: ingredients.isStaple,
      aisle: aisles.name,
      qty: recipeIngredients.qty,
      unit: recipeIngredients.unit,
    })
    .from(planEntries)
    .innerJoin(mealPlans, eq(mealPlans.id, planEntries.planId))
    .innerJoin(recipes, eq(recipes.id, planEntries.recipeId))
    .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
    .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .leftJoin(aisles, eq(aisles.id, ingredients.aisleId))
    .where(
      and(
        eq(mealPlans.status, "active"),
        isNotNull(planEntries.recipeId),
        gte(planEntries.date, start),
        lte(planEntries.date, end),
      ),
    );
  const lines: AggLine[] = rows.map((r) => ({
    entryId: r.entryId,
    ingredientId: r.ingredientId,
    ingredientName: r.ingredientName,
    aisle: r.aisle,
    isStaple: r.isStaple,
    qty: r.qty,
    unit: r.unit,
    scale: r.servingsOverride && r.servings ? r.servingsOverride / r.servings : 1,
  }));
  return aggregate(lines, includeStaples);
}

async function listFull(db: DB, id: number) {
  const list = await db.query.shoppingLists.findFirst({ where: eq(shoppingLists.id, id) });
  if (!list) notFound("List not found");
  const [items, aisleRows] = await db.batch([
    db.select().from(shoppingItems).where(eq(shoppingItems.listId, id)).orderBy(asc(shoppingItems.sort), asc(shoppingItems.id)),
    db.select().from(aisles).orderBy(asc(aisles.sort)),
  ]);
  return {
    id: list.id,
    name: list.name,
    start_date: list.startDate,
    end_date: list.endDate,
    include_staples: list.includeStaples,
    status: list.status,
    created_at: list.createdAt,
    aisle_order: aisleRows.map((a) => a.name),
    items: items.map((i) => ({
      id: i.id,
      ingredient_id: i.ingredientId,
      text: i.text,
      qty: i.qty,
      unit: i.unit,
      aisle: i.aisle,
      checked: i.checked,
      manual: i.manual,
      source_entry_ids: JSON.parse(i.sourceEntryIdsJson) as number[],
    })),
  };
}

function listName(start: string, end: string): string {
  const f = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

app.get("/lists", async (c) => {
  const rows = await c.var.db
    .select({
      list: shoppingLists,
      total: sql<number>`(select count(*) from ${shoppingItems} i where i.list_id = ${shoppingLists.id})`,
      checked: sql<number>`(select count(*) from ${shoppingItems} i where i.list_id = ${shoppingLists.id} and i.checked = 1)`,
    })
    .from(shoppingLists)
    .orderBy(desc(shoppingLists.createdAt))
    .limit(100);
  return c.json(
    rows.map((r) => ({
      id: r.list.id,
      name: r.list.name,
      start_date: r.list.startDate,
      end_date: r.list.endDate,
      status: r.list.status,
      created_at: r.list.createdAt,
      total: r.total,
      checked: r.checked,
    })),
  );
});

app.post("/lists", async (c) => {
  const db = c.var.db;
  const o = obj(await c.req.json().catch(() => ({})));
  const today = todayIn(c.env.APP_TZ || "America/Chicago");
  const start = optStr(o, "start") ?? today;
  const end = optStr(o, "end") ?? addDays(start, 6);
  if (!isDate(start) || !isDate(end)) bad("start and end must be dates (YYYY-MM-DD)");
  if (end < start) bad("end must be on or after start");
  if (daysBetween(start, end) > 62) bad("A list can cover at most two months");
  const includeStaples = optBool(o, "includeStaples") ?? false;
  const items = await buildItems(db, start, end, includeStaples);
  const [list] = await db
    .insert(shoppingLists)
    .values({ name: optStr(o, "name", { max: 100 }) ?? listName(start, end), startDate: start, endDate: end, includeStaples })
    .returning();
  await insertItems(db, list.id, items.map((i, sort) => ({ ...i, checked: false, sort })));
  return c.json(await listFull(db, list.id), 201);
});

async function insertItems(
  db: DB,
  listId: number,
  items: Array<{ ingredientId: number | null; text: string; qty: number | null; unit: string; aisle: string | null; sourceEntryIds: number[]; checked: boolean; sort: number; manual?: boolean }>,
) {
  const rows = items.map((i) => ({
    listId,
    ingredientId: i.ingredientId,
    text: i.text,
    qty: i.qty,
    unit: i.unit,
    aisle: i.aisle,
    checked: i.checked,
    manual: i.manual ?? false,
    sourceEntryIdsJson: JSON.stringify(i.sourceEntryIds),
    sort: i.sort,
  }));
  // 10 columns per row → 9 rows per statement stays under D1's 100-parameter cap.
  const stmts = chunk(rows, 9).map((part) => db.insert(shoppingItems).values(part));
  for (const part of chunk(stmts, 50)) await db.batch(part as [any, ...any[]]);
}

app.get("/lists/:id", async (c) => c.json(await listFull(c.var.db, idParam(c.req.param("id")))));

app.patch("/lists/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const o = obj(await c.req.json());
  const set: Partial<typeof shoppingLists.$inferInsert> = {};
  const name = optStr(o, "name", { max: 100 });
  if (name) set.name = name;
  const status = optStr(o, "status");
  if (status) {
    if (status !== "open" && status !== "done") bad("status must be open or done");
    set.status = status;
  }
  if (Object.keys(set).length) await c.var.db.update(shoppingLists).set(set).where(eq(shoppingLists.id, id));
  return c.json(await listFull(c.var.db, id));
});

app.delete("/lists/:id", async (c) => {
  await c.var.db.delete(shoppingLists).where(eq(shoppingLists.id, idParam(c.req.param("id"))));
  return c.json({ ok: true });
});

/** Rebuild generated lines; keep manual items and matching checked state (ARCHITECTURE §6.2). */
app.post("/lists/:id/regenerate", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const list = await db.query.shoppingLists.findFirst({ where: eq(shoppingLists.id, id) });
  if (!list) notFound("List not found");
  const o = obj(await c.req.json().catch(() => ({})));
  const includeStaples = optBool(o, "includeStaples") ?? list.includeStaples;
  const old = await db.select().from(shoppingItems).where(eq(shoppingItems.listId, id));
  const checkedKeys = new Set(
    old.filter((i) => !i.manual && i.checked).map((i) => itemKey(i.ingredientId, normalizeUnit(i.unit))),
  );
  const items = await buildItems(db, list.startDate, list.endDate, includeStaples);
  await db.batch([
    db.delete(shoppingItems).where(and(eq(shoppingItems.listId, id), eq(shoppingItems.manual, false))),
    db.update(shoppingLists).set({ includeStaples }).where(eq(shoppingLists.id, id)),
  ]);
  await insertItems(
    db,
    id,
    items.map((i, sort) => ({ ...i, checked: checkedKeys.has(i.key), sort })),
  );
  return c.json(await listFull(db, id));
});

app.post("/lists/:id/items", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const list = await db.query.shoppingLists.findFirst({ where: eq(shoppingLists.id, id) });
  if (!list) notFound("List not found");
  const o = obj(await c.req.json());
  const text = str(o, "text", { max: 120 });
  let aisle = optStr(o, "aisle", { max: 60 }) ?? null;
  let ingredientId: number | null = null;
  // If the text names a known ingredient, use its aisle.
  const ing = await db
    .select({ id: ingredients.id, aisle: aisles.name })
    .from(ingredients)
    .leftJoin(aisles, eq(aisles.id, ingredients.aisleId))
    .where(sql`lower(${ingredients.name}) = ${text.toLowerCase()}`)
    .limit(1);
  if (ing[0]) {
    ingredientId = ing[0].id;
    aisle ??= ing[0].aisle;
  }
  await db.insert(shoppingItems).values({
    listId: id,
    ingredientId,
    text,
    qty: optNum(o, "qty", { min: 0, max: 100000 }) ?? null,
    unit: normalizeUnit(optStr(o, "unit", { max: 30 }) ?? ""),
    aisle,
    manual: true,
    sort: 10000,
  });
  return c.json(await listFull(db, id), 201);
});

app.patch("/lists/:id/items/:itemId", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const itemId = idParam(c.req.param("itemId"));
  const o = obj(await c.req.json());
  const set: Partial<typeof shoppingItems.$inferInsert> = {};
  const checked = optBool(o, "checked");
  if (checked !== undefined) set.checked = checked;
  const text = optStr(o, "text", { max: 120 });
  if (text) set.text = text;
  const qty = optNum(o, "qty", { min: 0, max: 100000 });
  if (qty !== undefined) set.qty = qty;
  const unit = optStr(o, "unit", { max: 30 });
  if (unit !== undefined) set.unit = normalizeUnit(unit ?? "");
  const aisle = optStr(o, "aisle", { max: 60 });
  if (aisle !== undefined) set.aisle = aisle;
  if (!Object.keys(set).length) bad("Nothing to change");
  const res = await db
    .update(shoppingItems)
    .set(set)
    .where(and(eq(shoppingItems.id, itemId), eq(shoppingItems.listId, id)))
    .returning({ id: shoppingItems.id });
  if (!res.length) notFound("Item not found");
  return c.json(await listFull(db, id));
});

app.delete("/lists/:id/items/:itemId", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  await db
    .delete(shoppingItems)
    .where(and(eq(shoppingItems.id, idParam(c.req.param("itemId"))), eq(shoppingItems.listId, id)));
  return c.json(await listFull(db, id));
});

export default app;
