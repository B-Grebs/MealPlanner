import { Hono } from "hono";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  aisles,
  ingredients,
  ingredientProductLinks,
  recipeIngredients,
  recipeTags,
  recipes,
  shoppingItems,
  tags,
} from "../db/schema";
import type { AppEnv } from "../env";
import { userId } from "../lib/auth";
import { bad, chunk, idParam, notFound, obj, optBool, optNum, optStr, str } from "../lib/http";
import { parseRecipeText, type ParsedRecipe } from "../lib/parse";
import { cleanName, ensureByName, loadRecipe, recipeOut, saveRecipe, tagsFor, type RecipeInput } from "../lib/recipes";

const app = new Hono<AppEnv>();

function readRecipe(body: unknown): RecipeInput {
  const o = obj(body);
  const ingsRaw = o.ingredients ?? [];
  if (!Array.isArray(ingsRaw)) bad("ingredients must be a list");
  if (ingsRaw.length > 100) bad("A recipe can have at most 100 ingredients");
  const tagsRaw = o.tags ?? [];
  if (!Array.isArray(tagsRaw)) bad("tags must be a list");
  return {
    title: str(o, "title", { max: 200 }),
    description: optStr(o, "description", { max: 2000 }) ?? null,
    servings: optNum(o, "servings", { min: 1, max: 100, int: true }) ?? 4,
    prep_min: optNum(o, "prep_min", { min: 0, max: 2000, int: true }) ?? null,
    cook_min: optNum(o, "cook_min", { min: 0, max: 5000, int: true }) ?? null,
    instructions_md: optStr(o, "instructions_md", { max: 20000 }) ?? null,
    source_url: optStr(o, "source_url", { max: 1000 }) ?? null,
    prep_note: optStr(o, "prep_note", { max: 300 }) ?? null,
    favorite: optBool(o, "favorite") ?? false,
    archived: optBool(o, "archived") ?? false,
    tags: tagsRaw.filter((t): t is string => typeof t === "string").slice(0, 30),
    ingredients: ingsRaw.map((raw, i) => {
      const x = obj(raw, `ingredients[${i}]`);
      const iid = optNum(x, "ingredient_id", { min: 1, int: true });
      const name = optStr(x, "name", { max: 120 });
      if (!iid && !name) bad(`ingredients[${i}] needs a name`);
      return {
        ingredient_id: iid ?? null,
        name: name ?? null,
        qty: optNum(x, "qty", { min: 0, max: 100000 }) ?? null,
        unit: optStr(x, "unit", { max: 30 }) ?? "",
        note: optStr(x, "note", { max: 200 }) ?? null,
      };
    }),
  };
}

// ------------------------------------------------------------ recipes

app.get("/recipes", async (c) => {
  const db = c.var.db;
  const q = c.req.query("q")?.trim();
  const tag = c.req.query("tag")?.trim().toLowerCase();
  const archived = c.req.query("archived") === "1";
  const conds = [eq(recipes.archived, archived)];
  if (q) {
    const pat = `%${q.replace(/[%_]/g, "")}%`;
    conds.push(
      or(
        like(recipes.title, pat),
        sql`exists (select 1 from ${recipeIngredients} ri join ${ingredients} i on i.id = ri.ingredient_id
                    where ri.recipe_id = ${recipes.id} and i.name like ${pat})`,
      )!,
    );
  }
  if (tag) {
    conds.push(
      sql`exists (select 1 from ${recipeTags} rt join ${tags} t on t.id = rt.tag_id
                  where rt.recipe_id = ${recipes.id} and lower(t.name) = ${tag})`,
    );
  }
  const rows = await db
    .select()
    .from(recipes)
    .where(and(...conds))
    .orderBy(desc(recipes.favorite), asc(recipes.title))
    .limit(500);
  const tagMap = await tagsFor(db, rows.map((r) => r.id));
  return c.json(rows.map((r) => ({ ...recipeOut(r), tags: tagMap.get(r.id) ?? [] })));
});

app.get("/recipes/:id", async (c) => {
  const r = await loadRecipe(c.var.db, idParam(c.req.param("id")));
  if (!r) notFound("Recipe not found");
  return c.json(r);
});

app.post("/recipes", async (c) => {
  const input = readRecipe(await c.req.json());
  const id = await saveRecipe(c.var.db, input, { userId: userId(c.var.principal) });
  return c.json(await loadRecipe(c.var.db, id), 201);
});

app.put("/recipes/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const exists = await c.var.db.query.recipes.findFirst({ where: eq(recipes.id, id) });
  if (!exists) notFound("Recipe not found");
  const input = readRecipe(await c.req.json());
  await saveRecipe(c.var.db, input, { id });
  return c.json(await loadRecipe(c.var.db, id));
});

/** Archive, not delete: plans and lists keep pointing at it. */
app.delete("/recipes/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  await c.var.db.update(recipes).set({ archived: true }).where(eq(recipes.id, id));
  return c.json({ ok: true });
});

app.patch("/recipes/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const o = obj(await c.req.json());
  const fav = optBool(o, "favorite");
  const arch = optBool(o, "archived");
  const set: Partial<typeof recipes.$inferInsert> = {};
  if (fav !== undefined) set.favorite = fav;
  if (arch !== undefined) set.archived = arch;
  if (!Object.keys(set).length) bad("Nothing to change");
  await c.var.db.update(recipes).set(set).where(eq(recipes.id, id));
  return c.json(await loadRecipe(c.var.db, id));
});

// ------------------------------------------------------------ bulk import

function parsedToInput(p: ParsedRecipe): RecipeInput {
  return {
    title: p.title,
    description: p.description,
    servings: p.servings,
    prep_min: p.prep_min,
    cook_min: p.cook_min,
    instructions_md: p.instructions_md,
    source_url: p.source_url,
    prep_note: p.prep_note,
    favorite: p.favorite,
    tags: p.tags,
    ingredients: p.ingredients.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, note: i.note })),
  };
}

app.post("/import/recipes", async (c) => {
  const dryRun = c.req.query("dryRun") === "1";
  const ct = c.req.header("Content-Type") ?? "";
  let inputs: RecipeInput[];
  let warnings: string[] = [];
  const raw = await c.req.text();
  if (raw.length > 500_000) bad("That's too much at once; import in smaller pieces.");
  let json: unknown = undefined;
  if (ct.includes("json")) {
    try {
      json = JSON.parse(raw);
    } catch {
      bad("Body is not valid JSON");
    }
  }
  if (json && typeof json === "object" && !Array.isArray(json) && typeof (json as any).text === "string") {
    const parsed = parseRecipeText((json as any).text);
    inputs = parsed.recipes.map(parsedToInput);
    warnings = parsed.warnings;
  } else if (Array.isArray(json)) {
    inputs = json.map((r) => readRecipe(r));
  } else if (json !== undefined) {
    bad('Send {"text": "..."} or an array of recipes');
  } else {
    const parsed = parseRecipeText(raw);
    inputs = parsed.recipes.map(parsedToInput);
    warnings = parsed.warnings;
  }
  if (inputs.length > 60) bad("Import at most 60 recipes per request.");

  const db = c.var.db;
  // Flag titles that already exist so the preview can show them.
  const existing = new Set<string>();
  for (const part of chunk(inputs.map((i) => i.title.toLowerCase()), 90)) {
    const rows = await db
      .select({ title: recipes.title })
      .from(recipes)
      .where(and(inArray(sql`lower(${recipes.title})`, part), eq(recipes.archived, false)));
    rows.forEach((r) => existing.add(r.title.toLowerCase()));
  }
  const preview = inputs.map((i) => ({ ...i, duplicate: existing.has(i.title.toLowerCase()) }));
  if (dryRun) return c.json({ recipes: preview, warnings, created: [] });

  const skipDupes = c.req.query("skipDuplicates") !== "0";
  const toCreate = preview.filter((p) => !(skipDupes && p.duplicate));
  const ingIds = await ensureByName(
    db,
    ingredients,
    toCreate.flatMap((r) => (r.ingredients ?? []).map((i) => i.name ?? "")),
  );
  const tagIds = await ensureByName(db, tags, toCreate.flatMap((r) => r.tags ?? []));
  const created: Array<{ id: number; title: string }> = [];
  for (const r of toCreate) {
    const id = await saveRecipe(db, r, { userId: userId(c.var.principal), ingredientIds: ingIds, tagIds });
    created.push({ id, title: r.title });
  }
  return c.json({ recipes: preview, warnings, created }, 201);
});

// ------------------------------------------------------------ ingredients

const ingredientCols = {
  id: ingredients.id,
  name: ingredients.name,
  aisle_id: ingredients.aisleId,
  aisle: aisles.name,
  is_staple: ingredients.isStaple,
  default_unit: ingredients.defaultUnit,
};

app.get("/ingredients", async (c) => {
  const db = c.var.db;
  const q = c.req.query("q")?.trim().toLowerCase();
  const base = db
    .select({
      ...ingredientCols,
      uses: sql<number>`(select count(*) from ${recipeIngredients} ri where ri.ingredient_id = ${ingredients.id})`,
    })
    .from(ingredients)
    .leftJoin(aisles, eq(aisles.id, ingredients.aisleId));
  if (q) {
    const pat = `%${q.replace(/[%_]/g, "")}%`;
    const rows = await base
      .where(like(ingredients.name, pat))
      .orderBy(sql`case when lower(${ingredients.name}) = ${q} then 0 when lower(${ingredients.name}) like ${q + "%"} then 1 else 2 end`, asc(ingredients.name))
      .limit(20);
    return c.json(rows);
  }
  return c.json(await base.orderBy(asc(ingredients.name)).limit(2000));
});

app.put("/ingredients/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const o = obj(await c.req.json());
  const set: Partial<typeof ingredients.$inferInsert> = {};
  const name = optStr(o, "name", { max: 120 });
  if (name) set.name = cleanName(name);
  const aisleId = optNum(o, "aisle_id", { min: 1, int: true });
  if (aisleId !== undefined) set.aisleId = aisleId;
  const staple = optBool(o, "is_staple");
  if (staple !== undefined) set.isStaple = staple;
  const du = optStr(o, "default_unit", { max: 30 });
  if (du !== undefined) set.defaultUnit = du;
  if (!Object.keys(set).length) bad("Nothing to change");
  try {
    await c.var.db.update(ingredients).set(set).where(eq(ingredients.id, id));
  } catch (e) {
    if (String(e).includes("UNIQUE")) bad("Another ingredient already has that name; merge them instead.");
    throw e;
  }
  const [row] = await c.var.db
    .select(ingredientCols)
    .from(ingredients)
    .leftJoin(aisles, eq(aisles.id, ingredients.aisleId))
    .where(eq(ingredients.id, id));
  if (!row) notFound();
  return c.json(row);
});

/** Merge duplicate ingredients ("onion" into "yellow onion"). */
app.post("/ingredients/:id/merge-into/:target", async (c) => {
  const from = idParam(c.req.param("id"));
  const into = idParam(c.req.param("target"));
  if (from === into) bad("Pick a different ingredient");
  const db = c.var.db;
  const target = await db.query.ingredients.findFirst({ where: eq(ingredients.id, into) });
  if (!target) notFound("Target ingredient not found");
  await db.batch([
    db.update(recipeIngredients).set({ ingredientId: into }).where(eq(recipeIngredients.ingredientId, from)),
    db.update(shoppingItems).set({ ingredientId: into }).where(eq(shoppingItems.ingredientId, from)),
    db.run(sql`insert or ignore into ${ingredientProductLinks} (ingredient_id, product_id, preferred, created_at, created_by)
               select ${into}, product_id, preferred, created_at, created_by from ${ingredientProductLinks} where ingredient_id = ${from}`),
    db.delete(ingredientProductLinks).where(eq(ingredientProductLinks.ingredientId, from)),
    db.delete(ingredients).where(eq(ingredients.id, from)),
  ]);
  return c.json({ ok: true });
});

// ------------------------------------------------------------ tags & aisles

app.get("/tags", async (c) => {
  const rows = await c.var.db
    .select({
      id: tags.id,
      name: tags.name,
      count: sql<number>`(select count(*) from ${recipeTags} rt join ${recipes} r on r.id = rt.recipe_id
                          where rt.tag_id = ${tags.id} and r.archived = 0)`,
    })
    .from(tags)
    .orderBy(asc(tags.name));
  return c.json(rows.filter((t) => t.count > 0));
});

app.get("/aisles", async (c) => {
  return c.json(await c.var.db.select().from(aisles).orderBy(asc(aisles.sort), asc(aisles.name)));
});

/** Replace the aisle list and order. Body: [{ id?, name }] in walk order. */
app.put("/aisles", async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body) || body.length > 60) bad("Send a list of up to 60 aisles");
  const db = c.var.db;
  const items = body.map((x, i) => {
    const o = obj(x, `aisles[${i}]`);
    return { id: optNum(o, "id", { min: 1, int: true }) ?? null, name: str(o, "name", { max: 60 }), sort: (i + 1) * 10 };
  });
  const names = new Set(items.map((i) => i.name.toLowerCase()));
  if (names.size !== items.length) bad("Aisle names must be different");
  const current = await db.select().from(aisles);
  const keepIds = new Set(items.filter((i) => i.id).map((i) => i.id!));
  const stmts: any[] = [];
  for (const a of current) if (!keepIds.has(a.id)) stmts.push(db.delete(aisles).where(eq(aisles.id, a.id)));
  // Temporary names avoid UNIQUE clashes while renaming/reordering.
  for (const i of items) if (i.id) stmts.push(db.update(aisles).set({ name: `__tmp_${i.id}` }).where(eq(aisles.id, i.id)));
  for (const i of items) {
    if (i.id) stmts.push(db.update(aisles).set({ name: i.name, sort: i.sort }).where(eq(aisles.id, i.id)));
    else stmts.push(db.insert(aisles).values({ name: i.name, sort: i.sort }));
  }
  if (stmts.length) await db.batch(stmts as [any, ...any[]]);
  return c.json(await db.select().from(aisles).orderBy(asc(aisles.sort)));
});

export default app;
