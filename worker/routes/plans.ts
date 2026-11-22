import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { mealPlans, planEntries, planRules, recipeIngredients, recipes } from "../db/schema";
import type { AppEnv, DB } from "../env";
import { addDays, isDate, isMonth, mapNthWeekday, monthDates, prevMonth } from "../lib/dates";
import { generatePlan, randomSeed } from "../lib/generate";
import { bad, chunk, idParam, notFound, obj, optBool, optNum, optStr, str } from "../lib/http";
import { tagsFor } from "../lib/recipes";

const app = new Hono<AppEnv>();
const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
type Slot = (typeof SLOTS)[number];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

async function getPlan(db: DB, id: number) {
  const p = await db.query.mealPlans.findFirst({ where: eq(mealPlans.id, id) });
  if (!p) notFound("Plan not found");
  return p;
}

function planOut(p: typeof mealPlans.$inferSelect) {
  return {
    id: p.id,
    month: p.month,
    name: p.name,
    status: p.status,
    parent_plan_id: p.parentPlanId,
    last_seed: p.lastSeed,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export async function planEntriesOut(db: DB, planId: number) {
  const rows = await db
    .select({
      id: planEntries.id,
      date: planEntries.date,
      slot: planEntries.slot,
      recipe_id: planEntries.recipeId,
      recipe_title: recipes.title,
      freeform_text: planEntries.freeformText,
      servings_override: planEntries.servingsOverride,
      locked: planEntries.locked,
      notes: planEntries.notes,
    })
    .from(planEntries)
    .leftJoin(recipes, eq(recipes.id, planEntries.recipeId))
    .where(eq(planEntries.planId, planId))
    .orderBy(asc(planEntries.date), asc(planEntries.slot));
  return rows;
}

async function planFull(db: DB, id: number) {
  const p = await getPlan(db, id);
  return { ...planOut(p), entries: await planEntriesOut(db, id) };
}

async function touch(db: DB, id: number, extra: Partial<typeof mealPlans.$inferInsert> = {}) {
  await db.update(mealPlans).set({ updatedAt: new Date().toISOString(), ...extra }).where(eq(mealPlans.id, id));
}

// ------------------------------------------------------------ plans

app.get("/plans", async (c) => {
  const month = c.req.query("month");
  const db = c.var.db;
  const where = month ? (isMonth(month) ? eq(mealPlans.month, month) : bad("month must be YYYY-MM")) : undefined;
  const rows = await db
    .select({
      plan: mealPlans,
      entries: sql<number>`(select count(*) from ${planEntries} e where e.plan_id = ${mealPlans.id}
                            and (e.recipe_id is not null or e.freeform_text is not null))`,
    })
    .from(mealPlans)
    .where(where)
    .orderBy(desc(mealPlans.month), desc(mealPlans.status), desc(mealPlans.updatedAt))
    .limit(200);
  return c.json(rows.map((r) => ({ ...planOut(r.plan), entry_count: r.entries })));
});

app.post("/plans", async (c) => {
  const o = obj(await c.req.json());
  const month = str(o, "month");
  if (!isMonth(month)) bad("month must be YYYY-MM");
  const db = c.var.db;
  const hasActive = await db.query.mealPlans.findFirst({
    where: and(eq(mealPlans.month, month), eq(mealPlans.status, "active")),
  });
  const [row] = await db
    .insert(mealPlans)
    .values({
      month,
      name: optStr(o, "name", { max: 100 }) ?? monthLabel(month),
      status: hasActive ? "draft" : "active",
    })
    .returning();
  return c.json(await planFull(db, row.id), 201);
});

app.get("/plans/:id", async (c) => c.json(await planFull(c.var.db, idParam(c.req.param("id")))));

app.put("/plans/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  await getPlan(c.var.db, id);
  const o = obj(await c.req.json());
  const name = optStr(o, "name", { max: 100 });
  if (name) await touch(c.var.db, id, { name });
  return c.json(await planFull(c.var.db, id));
});

app.delete("/plans/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  await c.var.db.delete(mealPlans).where(eq(mealPlans.id, id));
  return c.json({ ok: true });
});

app.post("/plans/:id/activate", async (c) => {
  const db = c.var.db;
  const id = idParam(c.req.param("id"));
  const p = await getPlan(db, id);
  await db.batch([
    db.update(mealPlans).set({ status: "draft" }).where(and(eq(mealPlans.month, p.month), ne(mealPlans.id, id))),
    db.update(mealPlans).set({ status: "active", updatedAt: new Date().toISOString() }).where(eq(mealPlans.id, id)),
  ]);
  return c.json(await planFull(db, id));
});

/** Copy a plan into another month, mapping by nth weekday (ARCHITECTURE §5). */
app.post("/plans/:id/copy", async (c) => {
  const db = c.var.db;
  const src = await getPlan(db, idParam(c.req.param("id")));
  const o = obj(await c.req.json());
  const target = str(o, "targetMonth");
  if (!isMonth(target)) bad("targetMonth must be YYYY-MM");
  const entries = await db.select().from(planEntries).where(eq(planEntries.planId, src.id));
  const hasActive = await db.query.mealPlans.findFirst({
    where: and(eq(mealPlans.month, target), eq(mealPlans.status, "active")),
  });
  const [plan] = await db
    .insert(mealPlans)
    .values({
      month: target,
      name: optStr(o, "name", { max: 100 }) ?? `${monthLabel(target)} (from ${monthLabel(src.month)})`,
      status: hasActive ? "draft" : "active",
      parentPlanId: src.id,
    })
    .returning();
  const seen = new Set<string>();
  const rows = [];
  for (const e of entries) {
    const date = target === src.month ? e.date : mapNthWeekday(e.date, target);
    if (!date || seen.has(`${date}|${e.slot}`)) continue;
    seen.add(`${date}|${e.slot}`);
    rows.push({
      planId: plan.id,
      date,
      slot: e.slot,
      recipeId: e.recipeId,
      freeformText: e.freeformText,
      servingsOverride: e.servingsOverride,
      locked: e.locked,
      notes: e.notes,
    });
  }
  // 8 columns per row → 12 rows per statement stays under D1's 100-parameter cap.
  const stmts = chunk(rows, 12).map((part) => db.insert(planEntries).values(part));
  if (stmts.length) await db.batch(stmts as [any, ...any[]]);
  return c.json(await planFull(db, plan.id), 201);
});

/** Regenerate every unlocked dinner in the plan's month. */
app.post("/plans/:id/generate", async (c) => {
  const db = c.var.db;
  const plan = await getPlan(db, idParam(c.req.param("id")));
  const o = obj(await c.req.json().catch(() => ({})));
  const seed = optNum(o, "seed", { min: 0, max: 2 ** 31, int: true }) ?? randomSeed();
  const slot: Slot = "dinner";

  const dates = monthDates(plan.month);
  const [recipeRows, ruleRows, existingRows, historyRows] = await db.batch([
    db
      .select({
        id: recipes.id,
        title: recipes.title,
        prepMin: recipes.prepMin,
        cookMin: recipes.cookMin,
        favorite: recipes.favorite,
        ingredientCount: sql<number>`(select count(*) from ${recipeIngredients} ri where ri.recipe_id = ${recipes.id})`,
        hasInstructions: sql<number>`${recipes.instructionsMd} is not null and ${recipes.instructionsMd} <> ''`,
      })
      .from(recipes)
      .where(eq(recipes.archived, false)),
    db.select().from(planRules).where(eq(planRules.active, true)).orderBy(asc(planRules.sort)),
    db.select().from(planEntries).where(and(eq(planEntries.planId, plan.id), eq(planEntries.slot, slot))),
    // Recent meals from other active plans before this month, for no-repeat across the boundary.
    db
      .select({ date: planEntries.date, recipeId: planEntries.recipeId })
      .from(planEntries)
      .innerJoin(mealPlans, eq(mealPlans.id, planEntries.planId))
      .where(
        and(
          eq(mealPlans.status, "active"),
          ne(mealPlans.id, plan.id),
          eq(planEntries.slot, slot),
          gte(planEntries.date, addDays(dates[0], -28)),
          lt(planEntries.date, dates[0]),
        ),
      ),
  ]);
  const usable = recipeRows.filter((r) => r.ingredientCount > 0 || r.hasInstructions);
  const tagMap = await tagsFor(db, usable.map((r) => r.id));
  const result = generatePlan({
    dates,
    seed,
    existing: existingRows.map((e) => ({
      date: e.date,
      recipeId: e.recipeId,
      freeformText: e.freeformText,
      locked: e.locked,
    })),
    history: historyRows.filter((h) => h.recipeId != null).map((h) => ({ date: h.date, recipeId: h.recipeId! })),
    recipes: usable.map((r) => ({
      id: r.id,
      title: r.title,
      tags: tagMap.get(r.id) ?? [],
      totalMin: r.prepMin == null && r.cookMin == null ? null : (r.prepMin ?? 0) + (r.cookMin ?? 0),
      favorite: r.favorite,
    })),
    rules: ruleRows.map((r) => {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(r.configJson);
      } catch {
        /* ignore a broken rule */
      }
      return { kind: r.kind, config };
    }),
  });

  // Keep notes/servings on regenerated days; replace only the meal.
  const existingByDate = new Map(existingRows.map((e) => [e.date, e]));
  const stmts: any[] = [];
  for (const a of result.assignments) {
    const cur = existingByDate.get(a.date);
    if (cur) {
      stmts.push(
        db
          .update(planEntries)
          .set({ recipeId: a.recipeId, freeformText: a.freeformText })
          .where(eq(planEntries.id, cur.id)),
      );
    } else if (a.recipeId || a.freeformText) {
      stmts.push(
        db.insert(planEntries).values({ planId: plan.id, date: a.date, slot, recipeId: a.recipeId, freeformText: a.freeformText }),
      );
    }
  }
  stmts.push(
    db.update(mealPlans).set({ lastSeed: seed, updatedAt: new Date().toISOString() }).where(eq(mealPlans.id, plan.id)),
  );
  for (const part of chunk(stmts, 50)) await db.batch(part as [any, ...any[]]);
  return c.json({ ...(await planFull(db, plan.id)), seed, warnings: result.warnings });
});

/** Upsert the entry for one date + slot. */
app.put("/plans/:id/entries", async (c) => {
  const db = c.var.db;
  const plan = await getPlan(db, idParam(c.req.param("id")));
  const o = obj(await c.req.json());
  const date = str(o, "date");
  if (!isDate(date) || !date.startsWith(plan.month)) bad(`date must be a day in ${plan.month}`);
  const slot = (optStr(o, "slot") ?? "dinner") as Slot;
  if (!SLOTS.includes(slot)) bad("Unknown slot");

  const cur = await db.query.planEntries.findFirst({
    where: and(eq(planEntries.planId, plan.id), eq(planEntries.date, date), eq(planEntries.slot, slot)),
  });
  const recipeId = optNum(o, "recipe_id", { min: 1, int: true });
  const freeform = optStr(o, "freeform_text", { max: 100 });
  const next = {
    recipeId: recipeId !== undefined ? recipeId : (cur?.recipeId ?? null),
    freeformText: freeform !== undefined ? freeform : (cur?.freeformText ?? null),
    servingsOverride:
      optNum(o, "servings_override", { min: 1, max: 100, int: true }) ?? (o.servings_override === null ? null : (cur?.servingsOverride ?? null)),
    locked: optBool(o, "locked") ?? cur?.locked ?? false,
    notes: (() => {
      const n = optStr(o, "notes", { max: 300 });
      return n !== undefined ? n : (cur?.notes ?? null);
    })(),
  };
  // Picking a recipe clears freeform text and vice versa.
  if (recipeId) next.freeformText = freeform ?? null;
  if (freeform) next.recipeId = recipeId ?? null;
  if (next.recipeId) {
    const r = await db.query.recipes.findFirst({ where: eq(recipes.id, next.recipeId) });
    if (!r) bad("That recipe doesn't exist");
  }

  const empty = !next.recipeId && !next.freeformText && !next.locked && !next.notes && !next.servingsOverride;
  if (empty) {
    if (cur) await db.delete(planEntries).where(eq(planEntries.id, cur.id));
  } else if (cur) {
    await db.update(planEntries).set(next).where(eq(planEntries.id, cur.id));
  } else {
    await db.insert(planEntries).values({ planId: plan.id, date, slot, ...next });
  }
  await touch(db, plan.id);
  return c.json(await planFull(db, plan.id));
});

app.delete("/plans/:id/entries/:entryId", async (c) => {
  const db = c.var.db;
  const planId = idParam(c.req.param("id"));
  await db
    .delete(planEntries)
    .where(and(eq(planEntries.planId, planId), eq(planEntries.id, idParam(c.req.param("entryId")))));
  await touch(db, planId);
  return c.json(await planFull(db, planId));
});

/** Swap two days (dinner slot). */
app.post("/plans/:id/swap", async (c) => {
  const db = c.var.db;
  const plan = await getPlan(db, idParam(c.req.param("id")));
  const o = obj(await c.req.json());
  const a = str(o, "a");
  const b = str(o, "b");
  if (!isDate(a) || !isDate(b) || !a.startsWith(plan.month) || !b.startsWith(plan.month)) bad("Pick two days in this month");
  const rows = await db
    .select()
    .from(planEntries)
    .where(and(eq(planEntries.planId, plan.id), eq(planEntries.slot, "dinner"), inArray(planEntries.date, [a, b])));
  const ea = rows.find((r) => r.date === a);
  const eb = rows.find((r) => r.date === b);
  const stmts: any[] = [];
  // Move through a placeholder date to avoid the unique (plan, date, slot) index.
  if (ea) stmts.push(db.update(planEntries).set({ date: "0000-00-00" }).where(eq(planEntries.id, ea.id)));
  if (eb) stmts.push(db.update(planEntries).set({ date: a }).where(eq(planEntries.id, eb.id)));
  if (ea) stmts.push(db.update(planEntries).set({ date: b }).where(eq(planEntries.id, ea.id)));
  if (stmts.length) await db.batch(stmts as [any, ...any[]]);
  await touch(db, plan.id);
  return c.json(await planFull(db, plan.id));
});

/** Clear every unlocked day. */
app.post("/plans/:id/clear", async (c) => {
  const db = c.var.db;
  const plan = await getPlan(db, idParam(c.req.param("id")));
  await db.delete(planEntries).where(and(eq(planEntries.planId, plan.id), eq(planEntries.locked, false)));
  await touch(db, plan.id);
  return c.json(await planFull(db, plan.id));
});

/** Convenience for the UI: the previous month's active plan, if any. */
app.get("/plans/previous/:month", async (c) => {
  const month = c.req.param("month");
  if (!isMonth(month)) bad("month must be YYYY-MM");
  const p = await c.var.db.query.mealPlans.findFirst({
    where: and(eq(mealPlans.month, prevMonth(month)), eq(mealPlans.status, "active")),
  });
  return c.json(p ? planOut(p) : null);
});

// ------------------------------------------------------------ rules

const RULE_KINDS = ["weekday_theme", "no_repeat_within", "tag_quota", "fixed_freeform", "weekday_max_time"] as const;

function readRule(o: Record<string, unknown>) {
  const kind = str(o, "kind") as (typeof RULE_KINDS)[number];
  if (!RULE_KINDS.includes(kind)) bad(`kind must be one of ${RULE_KINDS.join(", ")}`);
  const config = o.config ?? {};
  if (typeof config !== "object" || Array.isArray(config)) bad("config must be an object");
  const cfg = config as Record<string, unknown>;
  const wd = (k: string) => {
    const v = cfg[k];
    if (typeof v !== "number" || v < 0 || v > 6) bad(`config.${k} must be 0 (Sunday) to 6 (Saturday)`);
  };
  if (kind === "weekday_theme") {
    wd("weekday");
    if (typeof cfg.tag !== "string" || !cfg.tag.trim()) bad("config.tag is required");
    cfg.tag = cfg.tag.trim().toLowerCase();
  }
  if (kind === "fixed_freeform") {
    wd("weekday");
    if (typeof cfg.text !== "string" || !cfg.text.trim()) bad("config.text is required");
  }
  if (kind === "no_repeat_within" && (typeof cfg.days !== "number" || cfg.days < 1)) bad("config.days must be 1 or more");
  if (kind === "tag_quota") {
    if (typeof cfg.tag !== "string" || !cfg.tag.trim()) bad("config.tag is required");
    cfg.tag = cfg.tag.trim().toLowerCase();
    if (typeof cfg.per_week !== "number" || cfg.per_week < 1) bad("config.per_week must be 1 or more");
  }
  if (kind === "weekday_max_time") {
    if (!Array.isArray(cfg.weekdays) || cfg.weekdays.some((d) => typeof d !== "number" || d < 0 || d > 6)) {
      bad("config.weekdays must be a list of 0-6");
    }
    if (typeof cfg.max_total_min !== "number" || cfg.max_total_min < 1) bad("config.max_total_min must be 1 or more");
  }
  return {
    name: str(o, "name", { max: 100 }),
    kind,
    configJson: JSON.stringify(cfg),
    active: optBool(o, "active") ?? true,
    sort: optNum(o, "sort", { int: true }) ?? 100,
  };
}

function ruleOut(r: typeof planRules.$inferSelect) {
  let config = {};
  try {
    config = JSON.parse(r.configJson);
  } catch {
    /* empty */
  }
  return { id: r.id, name: r.name, kind: r.kind, config, active: r.active, sort: r.sort };
}

app.get("/rules", async (c) => {
  const rows = await c.var.db.select().from(planRules).orderBy(asc(planRules.sort), asc(planRules.id));
  return c.json(rows.map(ruleOut));
});

app.post("/rules", async (c) => {
  const [row] = await c.var.db.insert(planRules).values(readRule(obj(await c.req.json()))).returning();
  return c.json(ruleOut(row), 201);
});

app.put("/rules/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const [row] = await c.var.db
    .update(planRules)
    .set(readRule(obj(await c.req.json())))
    .where(eq(planRules.id, id))
    .returning();
  if (!row) notFound("Rule not found");
  return c.json(ruleOut(row));
});

app.delete("/rules/:id", async (c) => {
  await c.var.db.delete(planRules).where(eq(planRules.id, idParam(c.req.param("id"))));
  return c.json({ ok: true });
});

export default app;
