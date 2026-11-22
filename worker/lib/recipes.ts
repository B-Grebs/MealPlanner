// Recipe persistence shared by the CRUD routes and bulk import.
// D1 caps bound parameters at 100 per statement and queries per invocation, so writes are batched.
import { asc, eq, inArray, sql } from "drizzle-orm";
import { aisles, ingredients, recipeIngredients, recipeTags, recipes, tags } from "../db/schema";
import type { DB } from "../env";
import { chunk } from "./http";
import { normalizeUnit } from "./units";

export interface RecipeInput {
  title: string;
  description?: string | null;
  servings?: number | null;
  prep_min?: number | null;
  cook_min?: number | null;
  instructions_md?: string | null;
  source_url?: string | null;
  prep_note?: string | null;
  favorite?: boolean;
  archived?: boolean;
  tags?: string[];
  ingredients?: Array<{
    ingredient_id?: number | null;
    name?: string | null;
    qty?: number | null;
    unit?: string | null;
    note?: string | null;
  }>;
}

export function cleanName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
}

/** Map lowercase names to ids, creating what's missing. */
export async function ensureByName(
  db: DB,
  table: typeof ingredients | typeof tags,
  names: string[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(names.map(cleanName).filter(Boolean))];
  const found = new Map<string, number>();
  const lookup = async (list: string[]) => {
    for (const part of chunk(list, 90)) {
      const rows = await db
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(inArray(sql`lower(${table.name})`, part));
      for (const r of rows) found.set(r.name.toLowerCase(), r.id);
    }
  };
  await lookup(wanted);
  const missing = wanted.filter((n) => !found.has(n));
  if (missing.length) {
    for (const part of chunk(missing, 90)) {
      await db
        .insert(table)
        .values(part.map((name) => ({ name })))
        .onConflictDoNothing();
    }
    await lookup(missing);
  }
  return found;
}

/** Insert or replace a recipe with its tags and ingredients. Returns the id. */
export async function saveRecipe(
  db: DB,
  input: RecipeInput,
  opts: { id?: number; userId?: number | null; ingredientIds?: Map<string, number>; tagIds?: Map<string, number> } = {},
): Promise<number> {
  const ings = (input.ingredients ?? []).filter((i) => i.ingredient_id || (i.name && i.name.trim()));
  const tagNames = [...new Set((input.tags ?? []).map(cleanName).filter(Boolean))];
  const ingIds =
    opts.ingredientIds ??
    (await ensureByName(db, ingredients, ings.filter((i) => !i.ingredient_id).map((i) => i.name!)));
  const tagIds = opts.tagIds ?? (await ensureByName(db, tags, tagNames));

  const values = {
    title: input.title.trim().slice(0, 200),
    description: input.description ?? null,
    servings: input.servings && input.servings > 0 ? Math.round(input.servings) : 4,
    prepMin: input.prep_min ?? null,
    cookMin: input.cook_min ?? null,
    instructionsMd: input.instructions_md ?? null,
    sourceUrl: input.source_url ?? null,
    prepNote: input.prep_note ?? null,
    favorite: !!input.favorite,
    archived: !!input.archived,
  };

  let id = opts.id;
  if (id) {
    await db
      .update(recipes)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(recipes.id, id));
  } else {
    const [row] = await db
      .insert(recipes)
      .values({ ...values, createdBy: opts.userId ?? null })
      .returning({ id: recipes.id });
    id = row.id;
  }

  const ingRows = ings.map((i, sort) => ({
    recipeId: id!,
    ingredientId: i.ingredient_id ?? ingIds.get(cleanName(i.name!))!,
    qty: i.qty ?? null,
    unit: normalizeUnit(i.unit),
    note: i.note?.trim() || null,
    sort,
  }));
  const tagRows = tagNames.map((n) => ({ recipeId: id!, tagId: tagIds.get(n)! }));

  const stmts: any[] = [
    db.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, id)),
    db.delete(recipeTags).where(eq(recipeTags.recipeId, id)),
  ];
  // 7 columns per ingredient row → 14 rows per statement stays under 100 params.
  for (const part of chunk(ingRows, 14)) stmts.push(db.insert(recipeIngredients).values(part));
  for (const part of chunk(tagRows, 40)) stmts.push(db.insert(recipeTags).values(part).onConflictDoNothing());
  await db.batch(stmts as [any, ...any[]]);
  return id;
}

export async function loadRecipe(db: DB, id: number) {
  const r = await db.query.recipes.findFirst({ where: eq(recipes.id, id) });
  if (!r) return null;
  // Not db.batch: D1 batch results come back keyed by column name, so the two
  // "name" columns (ingredient, aisle) would collide.
  const [ingRows, tagRows] = await Promise.all([
    db
      .select({
        id: recipeIngredients.id,
        ingredient_id: recipeIngredients.ingredientId,
        name: ingredients.name,
        qty: recipeIngredients.qty,
        unit: recipeIngredients.unit,
        note: recipeIngredients.note,
        aisle: aisles.name,
        is_staple: ingredients.isStaple,
      })
      .from(recipeIngredients)
      .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
      .leftJoin(aisles, eq(aisles.id, ingredients.aisleId))
      .where(eq(recipeIngredients.recipeId, id))
      .orderBy(asc(recipeIngredients.sort)),
    db
      .select({ name: tags.name })
      .from(recipeTags)
      .innerJoin(tags, eq(tags.id, recipeTags.tagId))
      .where(eq(recipeTags.recipeId, id))
      .orderBy(asc(tags.name)),
  ]);
  return { ...recipeOut(r), tags: tagRows.map((t) => t.name), ingredients: ingRows };
}

export function recipeOut(r: typeof recipes.$inferSelect) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    servings: r.servings,
    prep_min: r.prepMin,
    cook_min: r.cookMin,
    total_min: r.prepMin == null && r.cookMin == null ? null : (r.prepMin ?? 0) + (r.cookMin ?? 0),
    instructions_md: r.instructionsMd,
    source_url: r.sourceUrl,
    prep_note: r.prepNote,
    favorite: r.favorite,
    archived: r.archived,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Tag names for many recipes at once. */
export async function tagsFor(db: DB, ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const part of chunk(ids, 90)) {
    const rows = await db
      .select({ recipeId: recipeTags.recipeId, name: tags.name })
      .from(recipeTags)
      .innerJoin(tags, eq(tags.id, recipeTags.tagId))
      .where(inArray(recipeTags.recipeId, part));
    for (const r of rows) {
      const a = out.get(r.recipeId) ?? [];
      a.push(r.name.toLowerCase());
      out.set(r.recipeId, a);
    }
  }
  for (const a of out.values()) a.sort();
  return out;
}

