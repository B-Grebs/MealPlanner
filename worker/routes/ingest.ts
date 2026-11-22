// External data feeds: store products, prices, purchases (ARCHITECTURE §7).
import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import {
  ingestRuns,
  ingredientProductLinks,
  ingredients,
  mealPlans,
  planEntries,
  productPrices,
  purchaseItems,
  purchases,
  recipeIngredients,
  retailers,
  shoppingItems,
  shoppingLists,
  storeProducts,
} from "../db/schema";
import type { AppEnv, DB, Principal } from "../env";
import { allow, sourceName, userId } from "../lib/auth";
import { addDays, todayIn } from "../lib/dates";
import { bad, chunk, clip, idParam, notFound, obj, optBool, rawJson } from "../lib/http";

const MAX_BATCH = 500;
const app = new Hono<AppEnv>();

type Obj = Record<string, unknown>;

function s(o: Obj, k: string, max = 300): string | null {
  const v = o[k];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") throw new Error(`${k} must be text`);
  return clip(v.trim(), max) || null;
}

function n(o: Obj, k: string, { int = false } = {}): number | null {
  const v = o[k];
  if (v === undefined || v === null || v === "") return null;
  const x = typeof v === "string" ? Number(v) : v;
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`${k} must be a number`);
  return int ? Math.round(x) : x;
}

function iso(o: Obj, k: string): string | null {
  const v = s(o, k, 40);
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${k} must be an ISO date-time`);
  return d.toISOString();
}

async function resolveRetailer(db: DB, body: Obj): Promise<number> {
  const slug = typeof body.retailer === "string" ? body.retailer.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) bad("retailer must be a slug like target, amazon or costco");
  const found = await db.query.retailers.findFirst({ where: eq(retailers.slug, slug) });
  if (found) return found.id;
  const name = typeof body.retailerName === "string" ? body.retailerName.trim().slice(0, 60) : "";
  if (!name) bad(`Unknown retailer "${slug}". Send retailerName to create it.`);
  const [row] = await db.insert(retailers).values({ slug, name }).onConflictDoNothing().returning();
  return row?.id ?? (await db.query.retailers.findFirst({ where: eq(retailers.slug, slug) }))!.id;
}

async function logRun(db: DB, p: Principal, kind: string, r: { received: number; inserted: number; updated: number; skipped: number; errors: unknown[] }) {
  await db.insert(ingestRuns).values({
    clientId: p.kind === "client" ? p.clientDbId : null,
    kind,
    received: r.received,
    inserted: r.inserted,
    updated: r.updated,
    skipped: r.skipped,
    errorsJson: JSON.stringify(r.errors.slice(0, 50)),
  });
}

interface ProductIn {
  externalId: string;
  name: string;
  values: Omit<typeof storeProducts.$inferInsert, "retailerId" | "externalId">;
  price: Omit<typeof productPrices.$inferInsert, "productId"> | null;
}

function readProduct(raw: unknown, source: string, now: string): ProductIn {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("item must be an object");
  const o = raw as Obj;
  const externalId = s(o, "external_id", 100);
  const name = s(o, "name", 300);
  if (!externalId) throw new Error("external_id is required");
  if (!name) throw new Error("name is required");
  let price: ProductIn["price"] = null;
  if (o.price !== undefined && o.price !== null) {
    if (typeof o.price !== "object" || Array.isArray(o.price)) throw new Error("price must be an object");
    const p = o.price as Obj;
    const cents = n(p, "price_cents", { int: true });
    if (cents == null || cents < 0) throw new Error("price.price_cents is required");
    const inStock = p.in_stock;
    price = {
      priceCents: cents,
      currency: (s(p, "currency", 3) ?? "USD").toUpperCase(),
      unitPriceCents: n(p, "unit_price_cents", { int: true }),
      inStock: typeof inStock === "boolean" ? inStock : null,
      storeRef: s(p, "store_ref", 60),
      observedAt: iso(p, "observed_at") ?? now,
      source,
    };
  }
  return {
    externalId,
    name,
    values: {
      name,
      brand: s(o, "brand", 120),
      sizeText: s(o, "size_text", 60),
      packQty: n(o, "pack_qty"),
      packUnit: s(o, "pack_unit", 20),
      upc: s(o, "upc", 20),
      url: s(o, "url", 1000),
      imageUrl: s(o, "image_url", 1000),
      source,
      lastSeenAt: now,
      rawJson: rawJson(o.raw),
    },
    price,
  };
}

/** Upsert products by (retailer, external_id); returns external_id → product id. */
async function upsertProducts(db: DB, retailerId: number, items: ProductIn[]) {
  const ids = new Map<string, number>();
  const before = new Set<string>();
  for (const part of chunk(items.map((i) => i.externalId), 90)) {
    const rows = await db
      .select({ externalId: storeProducts.externalId })
      .from(storeProducts)
      .where(and(eq(storeProducts.retailerId, retailerId), inArray(storeProducts.externalId, part)));
    rows.forEach((r) => before.add(r.externalId));
  }
  // 14 columns per row → 6 rows per statement stays under 100 bound parameters.
  const stmts = chunk(items, 6).map((part) =>
    db
      .insert(storeProducts)
      .values(part.map((i) => ({ retailerId, externalId: i.externalId, ...i.values })))
      .onConflictDoUpdate({
        target: [storeProducts.retailerId, storeProducts.externalId],
        set: {
          name: sql`excluded.name`,
          brand: sql`coalesce(excluded.brand, ${storeProducts.brand})`,
          sizeText: sql`coalesce(excluded.size_text, ${storeProducts.sizeText})`,
          packQty: sql`coalesce(excluded.pack_qty, ${storeProducts.packQty})`,
          packUnit: sql`coalesce(excluded.pack_unit, ${storeProducts.packUnit})`,
          upc: sql`coalesce(excluded.upc, ${storeProducts.upc})`,
          url: sql`coalesce(excluded.url, ${storeProducts.url})`,
          imageUrl: sql`coalesce(excluded.image_url, ${storeProducts.imageUrl})`,
          lastSeenAt: sql`excluded.last_seen_at`,
          rawJson: sql`coalesce(excluded.raw_json, ${storeProducts.rawJson})`,
        },
      }),
  );
  for (const part of chunk(stmts, 50)) await db.batch(part as [any, ...any[]]);
  for (const part of chunk(items.map((i) => i.externalId), 90)) {
    const rows = await db
      .select({ id: storeProducts.id, externalId: storeProducts.externalId })
      .from(storeProducts)
      .where(and(eq(storeProducts.retailerId, retailerId), inArray(storeProducts.externalId, part)));
    rows.forEach((r) => ids.set(r.externalId, r.id));
  }
  const inserted = new Set(items.map((i) => i.externalId).filter((e) => !before.has(e))).size;
  return { ids, inserted, updated: new Set(items.map((i) => i.externalId)).size - inserted };
}

async function addPrices(db: DB, rows: Array<typeof productPrices.$inferInsert>): Promise<number> {
  let added = 0;
  // 9 columns per row → 10 rows per statement.
  const stmts = chunk(rows, 10).map((part) =>
    db.insert(productPrices).values(part).onConflictDoNothing().returning({ id: productPrices.id }),
  );
  for (const part of chunk(stmts, 50)) {
    const res = (await db.batch(part as [any, ...any[]])) as Array<Array<{ id: number }>>;
    for (const r of res) added += r.length;
  }
  return added;
}

// ------------------------------------------------------------ ingest (scope: ingest)

app.post("/ingest/products", allow("ingest"), async (c) => {
  const db = c.var.db;
  const body = obj(await c.req.json());
  if (!Array.isArray(body.items)) bad("items must be a list");
  if (body.items.length > MAX_BATCH) bad(`At most ${MAX_BATCH} items per request`);
  const retailerId = await resolveRetailer(db, body);
  const source = sourceName(c.var.principal);
  const now = new Date().toISOString();
  const errors: Array<{ index: number; error: string }> = [];
  const byExt = new Map<string, ProductIn>();
  body.items.forEach((raw, index) => {
    try {
      const p = readProduct(raw, source, now);
      byExt.set(p.externalId, p); // last one wins within a batch
    } catch (e) {
      errors.push({ index, error: (e as Error).message });
    }
  });
  const items = [...byExt.values()];
  const { ids, inserted, updated } = items.length ? await upsertProducts(db, retailerId, items) : { ids: new Map(), inserted: 0, updated: 0 };
  const prices = items
    .filter((i) => i.price && ids.has(i.externalId))
    .map((i) => ({ ...i.price!, productId: ids.get(i.externalId)! }));
  const pricesAdded = prices.length ? await addPrices(db, prices) : 0;
  const result = {
    received: body.items.length,
    inserted,
    updated,
    prices_added: pricesAdded,
    skipped: body.items.length - items.length,
    errors,
  };
  await logRun(db, c.var.principal, "products", result);
  return c.json(result);
});

app.post("/ingest/purchases", allow("ingest"), async (c) => {
  const db = c.var.db;
  const body = obj(await c.req.json());
  if (!Array.isArray(body.orders)) bad("orders must be a list");
  if (body.orders.length > MAX_BATCH) bad(`At most ${MAX_BATCH} orders per request`);
  const retailerId = await resolveRetailer(db, body);
  const source = sourceName(c.var.principal);
  const now = new Date().toISOString();
  const errors: Array<{ index: number; error: string }> = [];
  let inserted = 0;
  let updated = 0;
  let itemCount = 0;

  interface OrderIn {
    externalOrderId: string;
    orderedAt: string;
    totalCents: number | null;
    currency: string;
    raw: string | null;
    items: Array<{ lineKey: string; externalId: string | null; name: string; qty: number; unitPriceCents: number | null; totalCents: number | null }>;
  }
  const orders: OrderIn[] = [];
  body.orders.forEach((raw, index) => {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("order must be an object");
      const o = raw as Obj;
      const externalOrderId = s(o, "external_order_id", 100);
      const orderedAt = iso(o, "ordered_at");
      if (!externalOrderId) throw new Error("external_order_id is required");
      if (!orderedAt) throw new Error("ordered_at is required");
      const itemsRaw = o.items ?? [];
      if (!Array.isArray(itemsRaw)) throw new Error("items must be a list");
      if (itemsRaw.length > 300) throw new Error("At most 300 items per order");
      const items = itemsRaw.map((ir, i) => {
        if (!ir || typeof ir !== "object") throw new Error(`items[${i}] must be an object`);
        const it = ir as Obj;
        const name = s(it, "name", 300);
        if (!name) throw new Error(`items[${i}].name is required`);
        return {
          lineKey: s(it, "line_key", 60) ?? String(i + 1),
          externalId: s(it, "external_id", 100),
          name,
          qty: n(it, "qty") ?? 1,
          unitPriceCents: n(it, "unit_price_cents", { int: true }),
          totalCents: n(it, "total_cents", { int: true }),
        };
      });
      orders.push({
        externalOrderId,
        orderedAt,
        totalCents: n(o, "total_cents", { int: true }),
        currency: (s(o, "currency", 3) ?? "USD").toUpperCase(),
        raw: rawJson(o.raw),
        items,
      });
    } catch (e) {
      errors.push({ index, error: (e as Error).message });
    }
  });

  // Make sure every referenced product exists so purchase lines can link to it.
  const prodMap = new Map<string, ProductIn>();
  for (const o of orders) {
    for (const it of o.items) {
      if (it.externalId && !prodMap.has(it.externalId)) {
        prodMap.set(it.externalId, readProduct({ external_id: it.externalId, name: it.name }, source, now));
      }
    }
  }
  let productIds = new Map<string, number>();
  if (prodMap.size) {
    // Don't overwrite a richer product name from a products feed with an order line's name.
    const existing = new Set<string>();
    for (const part of chunk([...prodMap.keys()], 90)) {
      const rows = await db
        .select({ externalId: storeProducts.externalId, id: storeProducts.id })
        .from(storeProducts)
        .where(and(eq(storeProducts.retailerId, retailerId), inArray(storeProducts.externalId, part)));
      rows.forEach((r) => {
        existing.add(r.externalId);
        productIds.set(r.externalId, r.id);
      });
    }
    const missing = [...prodMap.values()].filter((p) => !existing.has(p.externalId));
    if (missing.length) {
      const res = await upsertProducts(db, retailerId, missing);
      for (const [k, v] of res.ids) productIds.set(k, v);
    }
  }

  for (const o of orders) {
    const prior = await db.query.purchases.findFirst({
      where: and(eq(purchases.retailerId, retailerId), eq(purchases.externalOrderId, o.externalOrderId)),
    });
    const [row] = await db
      .insert(purchases)
      .values({
        retailerId,
        externalOrderId: o.externalOrderId,
        orderedAt: o.orderedAt,
        totalCents: o.totalCents,
        currency: o.currency,
        source,
        rawJson: o.raw,
        importedAt: now,
      })
      .onConflictDoUpdate({
        target: [purchases.retailerId, purchases.externalOrderId],
        set: {
          orderedAt: sql`excluded.ordered_at`,
          totalCents: sql`coalesce(excluded.total_cents, ${purchases.totalCents})`,
          currency: sql`excluded.currency`,
          rawJson: sql`coalesce(excluded.raw_json, ${purchases.rawJson})`,
          importedAt: sql`excluded.imported_at`,
        },
      })
      .returning({ id: purchases.id });
    if (prior) updated++;
    else inserted++;
    const lines = o.items.map((it) => ({
      purchaseId: row.id,
      lineKey: it.lineKey,
      productId: it.externalId ? (productIds.get(it.externalId) ?? null) : null,
      name: it.name,
      qty: it.qty,
      unitPriceCents: it.unitPriceCents,
      totalCents: it.totalCents,
    }));
    itemCount += lines.length;
    // 7 columns per row → 14 rows per statement.
    const stmts = chunk(lines, 14).map((part) =>
      db
        .insert(purchaseItems)
        .values(part)
        .onConflictDoUpdate({
          target: [purchaseItems.purchaseId, purchaseItems.lineKey],
          set: {
            productId: sql`excluded.product_id`,
            name: sql`excluded.name`,
            qty: sql`excluded.qty`,
            unitPriceCents: sql`excluded.unit_price_cents`,
            totalCents: sql`excluded.total_cents`,
          },
        }),
    );
    for (const part of chunk(stmts, 50)) if (part.length) await db.batch(part as [any, ...any[]]);
  }

  const result = { received: body.orders.length, inserted, updated, items: itemCount, skipped: body.orders.length - orders.length, errors };
  await logRun(db, c.var.principal, "purchases", result);
  return c.json(result);
});

/** What a feeder should look up next: ingredients on open lists and upcoming active plans. */
app.get("/ingest/wanted", allow("ingest", "read"), async (c) => {
  const db = c.var.db;
  const retailer = c.req.query("retailer")?.toLowerCase();
  const today = todayIn(c.env.APP_TZ || "America/Chicago");
  const [fromLists, fromPlans] = await db.batch([
    db
      .selectDistinct({ id: ingredients.id, name: ingredients.name })
      .from(shoppingItems)
      .innerJoin(shoppingLists, eq(shoppingLists.id, shoppingItems.listId))
      .innerJoin(ingredients, eq(ingredients.id, shoppingItems.ingredientId))
      .where(eq(shoppingLists.status, "open")),
    db
      .selectDistinct({ id: ingredients.id, name: ingredients.name })
      .from(planEntries)
      .innerJoin(mealPlans, eq(mealPlans.id, planEntries.planId))
      .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, planEntries.recipeId))
      .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
      .where(and(eq(mealPlans.status, "active"), gte(planEntries.date, today), lte(planEntries.date, addDays(today, 21)))),
  ]);
  const all = new Map<number, string>();
  for (const r of [...fromLists, ...fromPlans]) all.set(r.id, r.name);
  const ids = [...all.keys()];
  const links = new Map<number, Array<{ retailer: string; external_id: string; product_id: number; name: string; preferred: boolean }>>();
  for (const part of chunk(ids, 90)) {
    const rows = await db
      .select({
        ingredientId: ingredientProductLinks.ingredientId,
        preferred: ingredientProductLinks.preferred,
        productId: storeProducts.id,
        externalId: storeProducts.externalId,
        name: storeProducts.name,
        retailer: retailers.slug,
      })
      .from(ingredientProductLinks)
      .innerJoin(storeProducts, eq(storeProducts.id, ingredientProductLinks.productId))
      .innerJoin(retailers, eq(retailers.id, storeProducts.retailerId))
      .where(
        retailer
          ? and(inArray(ingredientProductLinks.ingredientId, part), eq(retailers.slug, retailer))
          : inArray(ingredientProductLinks.ingredientId, part),
      );
    for (const r of rows) {
      const a = links.get(r.ingredientId) ?? [];
      a.push({ retailer: r.retailer, external_id: r.externalId, product_id: r.productId, name: r.name, preferred: r.preferred });
      links.set(r.ingredientId, a);
    }
  }
  return c.json(
    ids
      .map((id) => ({ ingredient_id: id, name: all.get(id)!, products: links.get(id) ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

// ------------------------------------------------------------ user endpoints for store data

app.get("/ingest/runs", async (c) => {
  const rows = await c.var.db.select().from(ingestRuns).orderBy(desc(ingestRuns.at)).limit(100);
  return c.json(rows.map((r) => ({ ...r, errors: JSON.parse(r.errorsJson), errorsJson: undefined })));
});

app.get("/retailers", async (c) => {
  const rows = await c.var.db
    .select({
      id: retailers.id,
      slug: retailers.slug,
      name: retailers.name,
      products: sql<number>`(select count(*) from ${storeProducts} p where p.retailer_id = ${retailers.id})`,
      purchases: sql<number>`(select count(*) from ${purchases} p where p.retailer_id = ${retailers.id})`,
    })
    .from(retailers)
    .orderBy(asc(retailers.name));
  return c.json(rows);
});

const latestPrice = sql<number | null>`(select pp.price_cents from ${productPrices} pp where pp.product_id = ${storeProducts.id} order by pp.observed_at desc limit 1)`;
const latestObserved = sql<string | null>`(select pp.observed_at from ${productPrices} pp where pp.product_id = ${storeProducts.id} order by pp.observed_at desc limit 1)`;

const productCols = {
  id: storeProducts.id,
  retailer: retailers.slug,
  external_id: storeProducts.externalId,
  name: storeProducts.name,
  brand: storeProducts.brand,
  size_text: storeProducts.sizeText,
  url: storeProducts.url,
  image_url: storeProducts.imageUrl,
  last_seen_at: storeProducts.lastSeenAt,
  price_cents: latestPrice,
  price_observed_at: latestObserved,
};

app.get("/store-products", async (c) => {
  const q = c.req.query("q")?.trim();
  const retailer = c.req.query("retailer")?.trim().toLowerCase();
  const conds = [];
  if (q) {
    const pat = `%${q.replace(/[%_]/g, "")}%`;
    conds.push(or(like(storeProducts.name, pat), like(storeProducts.brand, pat), eq(storeProducts.externalId, q))!);
  }
  if (retailer) conds.push(eq(retailers.slug, retailer));
  const rows = await c.var.db
    .select(productCols)
    .from(storeProducts)
    .innerJoin(retailers, eq(retailers.id, storeProducts.retailerId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(storeProducts.lastSeenAt))
    .limit(100);
  return c.json(rows);
});

app.get("/ingredients/:id/products", async (c) => {
  const id = idParam(c.req.param("id"));
  const rows = await c.var.db
    .select({ ...productCols, preferred: ingredientProductLinks.preferred })
    .from(ingredientProductLinks)
    .innerJoin(storeProducts, eq(storeProducts.id, ingredientProductLinks.productId))
    .innerJoin(retailers, eq(retailers.id, storeProducts.retailerId))
    .where(eq(ingredientProductLinks.ingredientId, id))
    .orderBy(desc(ingredientProductLinks.preferred), asc(retailers.slug));
  return c.json(rows);
});

app.put("/ingredients/:id/products/:productId", async (c) => {
  const db = c.var.db;
  const ingredientId = idParam(c.req.param("id"));
  const productId = idParam(c.req.param("productId"));
  const o = obj(await c.req.json().catch(() => ({})));
  const preferred = optBool(o, "preferred") ?? false;
  const [ing, prod] = await Promise.all([
    db.query.ingredients.findFirst({ where: eq(ingredients.id, ingredientId) }),
    db.query.storeProducts.findFirst({ where: eq(storeProducts.id, productId) }),
  ]);
  if (!ing || !prod) notFound("Ingredient or product not found");
  await db
    .insert(ingredientProductLinks)
    .values({ ingredientId, productId, preferred, createdBy: userId(c.var.principal) })
    .onConflictDoUpdate({ target: [ingredientProductLinks.ingredientId, ingredientProductLinks.productId], set: { preferred } });
  return c.json({ ok: true });
});

app.delete("/ingredients/:id/products/:productId", async (c) => {
  await c.var.db
    .delete(ingredientProductLinks)
    .where(
      and(
        eq(ingredientProductLinks.ingredientId, idParam(c.req.param("id"))),
        eq(ingredientProductLinks.productId, idParam(c.req.param("productId"))),
      ),
    );
  return c.json({ ok: true });
});

app.get("/purchases", async (c) => {
  const db = c.var.db;
  const retailer = c.req.query("retailer")?.toLowerCase();
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const rows = await db
    .select({
      id: purchases.id,
      retailer: retailers.slug,
      external_order_id: purchases.externalOrderId,
      ordered_at: purchases.orderedAt,
      total_cents: purchases.totalCents,
      currency: purchases.currency,
      source: purchases.source,
      items: sql<number>`(select count(*) from ${purchaseItems} pi where pi.purchase_id = ${purchases.id})`,
    })
    .from(purchases)
    .innerJoin(retailers, eq(retailers.id, purchases.retailerId))
    .where(retailer ? eq(retailers.slug, retailer) : undefined)
    .orderBy(desc(purchases.orderedAt))
    .limit(limit);
  return c.json(rows);
});

app.get("/purchases/:id", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const p = await db.query.purchases.findFirst({ where: eq(purchases.id, id) });
  if (!p) notFound("Purchase not found");
  const items = await db
    .select({
      line_key: purchaseItems.lineKey,
      name: purchaseItems.name,
      qty: purchaseItems.qty,
      unit_price_cents: purchaseItems.unitPriceCents,
      total_cents: purchaseItems.totalCents,
      product_id: purchaseItems.productId,
    })
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, id))
    .orderBy(asc(purchaseItems.id));
  return c.json({ ...p, rawJson: undefined, items });
});

export default app;
