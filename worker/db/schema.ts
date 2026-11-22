import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const id = () => integer("id").primaryKey({ autoIncrement: true });
const bool = (name: string) => integer(name, { mode: "boolean" });

// ---------------------------------------------------------------- core

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: text("created_at").notNull().default(now),
});

export const aisles = sqliteTable("aisles", {
  id: id(),
  name: text("name").notNull().unique(),
  sort: integer("sort").notNull().default(0),
});

export const ingredients = sqliteTable(
  "ingredients",
  {
    id: id(),
    name: text("name").notNull(),
    aisleId: integer("aisle_id").references(() => aisles.id, { onDelete: "set null" }),
    isStaple: bool("is_staple").notNull().default(false),
    defaultUnit: text("default_unit"),
  },
  (t) => [uniqueIndex("ingredients_name_uq").on(sql`${t.name} COLLATE NOCASE`)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: id(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("tags_name_uq").on(sql`${t.name} COLLATE NOCASE`)],
);

export const recipes = sqliteTable(
  "recipes",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    servings: integer("servings").notNull().default(4),
    prepMin: integer("prep_min"),
    cookMin: integer("cook_min"),
    instructionsMd: text("instructions_md"),
    sourceUrl: text("source_url"),
    photoKey: text("photo_key"),
    prepNote: text("prep_note"),
    favorite: bool("favorite").notNull().default(false),
    archived: bool("archived").notNull().default(false),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("recipes_title_idx").on(t.title)],
);

export const recipeTags = sqliteTable(
  "recipe_tags",
  {
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.recipeId, t.tagId] })],
);

export const recipeIngredients = sqliteTable(
  "recipe_ingredients",
  {
    id: id(),
    recipeId: integer("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "restrict" }),
    qty: real("qty"),
    unit: text("unit").notNull().default(""),
    note: text("note"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("recipe_ingredients_recipe_idx").on(t.recipeId)],
);

// ---------------------------------------------------------------- planning

export const mealPlans = sqliteTable(
  "meal_plans",
  {
    id: id(),
    month: text("month").notNull(), // YYYY-MM
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "active"] }).notNull().default("draft"),
    parentPlanId: integer("parent_plan_id"),
    lastSeed: integer("last_seed"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("meal_plans_month_idx").on(t.month)],
);

export const planEntries = sqliteTable(
  "plan_entries",
  {
    id: id(),
    planId: integer("plan_id")
      .notNull()
      .references(() => mealPlans.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD
    slot: text("slot", { enum: ["breakfast", "lunch", "dinner", "snack"] })
      .notNull()
      .default("dinner"),
    recipeId: integer("recipe_id").references(() => recipes.id, { onDelete: "set null" }),
    freeformText: text("freeform_text"),
    servingsOverride: integer("servings_override"),
    locked: bool("locked").notNull().default(false),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("plan_entries_slot_uq").on(t.planId, t.date, t.slot),
    index("plan_entries_date_idx").on(t.date),
  ],
);

export const planRules = sqliteTable("plan_rules", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind", {
    enum: ["weekday_theme", "no_repeat_within", "tag_quota", "fixed_freeform", "weekday_max_time"],
  }).notNull(),
  configJson: text("config_json").notNull().default("{}"),
  active: bool("active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
});

// ---------------------------------------------------------------- shopping

export const shoppingLists = sqliteTable("shopping_lists", {
  id: id(),
  name: text("name").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  includeStaples: bool("include_staples").notNull().default(false),
  status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
  createdAt: text("created_at").notNull().default(now),
});

export const shoppingItems = sqliteTable(
  "shopping_items",
  {
    id: id(),
    listId: integer("list_id")
      .notNull()
      .references(() => shoppingLists.id, { onDelete: "cascade" }),
    ingredientId: integer("ingredient_id").references(() => ingredients.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    qty: real("qty"),
    unit: text("unit").notNull().default(""),
    aisle: text("aisle"),
    checked: bool("checked").notNull().default(false),
    manual: bool("manual").notNull().default(false),
    sourceEntryIdsJson: text("source_entry_ids_json").notNull().default("[]"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("shopping_items_list_idx").on(t.listId)],
);

// ---------------------------------------------------------------- machine clients

export const apiClients = sqliteTable("api_clients", {
  id: id(),
  name: text("name").notNull().unique(),
  clientId: text("client_id").notNull().unique(), // Access service token Client ID
  scopes: text("scopes").notNull().default("ha"), // comma-separated: ha,ingest,read
  active: bool("active").notNull().default(true),
  createdAt: text("created_at").notNull().default(now),
  lastSeenAt: text("last_seen_at"),
});

export const feedTokens = sqliteTable("feed_tokens", {
  id: id(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull().default(now),
  lastUsedAt: text("last_used_at"),
  revoked: bool("revoked").notNull().default(false),
});

// ---------------------------------------------------------------- store data feeds

export const retailers = sqliteTable("retailers", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
});

export const storeProducts = sqliteTable(
  "store_products",
  {
    id: id(),
    retailerId: integer("retailer_id")
      .notNull()
      .references(() => retailers.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    brand: text("brand"),
    sizeText: text("size_text"),
    packQty: real("pack_qty"),
    packUnit: text("pack_unit"),
    upc: text("upc"),
    url: text("url"),
    imageUrl: text("image_url"),
    source: text("source").notNull(),
    firstSeenAt: text("first_seen_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    rawJson: text("raw_json"),
  },
  (t) => [
    uniqueIndex("store_products_ext_uq").on(t.retailerId, t.externalId),
    index("store_products_name_idx").on(t.name),
  ],
);

export const productPrices = sqliteTable(
  "product_prices",
  {
    id: id(),
    productId: integer("product_id")
      .notNull()
      .references(() => storeProducts.id, { onDelete: "cascade" }),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    unitPriceCents: integer("unit_price_cents"),
    inStock: bool("in_stock"),
    storeRef: text("store_ref"),
    observedAt: text("observed_at").notNull(),
    source: text("source").notNull(),
  },
  (t) => [
    uniqueIndex("product_prices_obs_uq").on(t.productId, t.observedAt, t.source),
    index("product_prices_product_idx").on(t.productId, t.observedAt),
  ],
);

export const ingredientProductLinks = sqliteTable(
  "ingredient_product_links",
  {
    ingredientId: integer("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => storeProducts.id, { onDelete: "cascade" }),
    preferred: bool("preferred").notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.ingredientId, t.productId] })],
);

export const purchases = sqliteTable(
  "purchases",
  {
    id: id(),
    retailerId: integer("retailer_id")
      .notNull()
      .references(() => retailers.id, { onDelete: "cascade" }),
    externalOrderId: text("external_order_id").notNull(),
    orderedAt: text("ordered_at").notNull(),
    totalCents: integer("total_cents"),
    currency: text("currency").notNull().default("USD"),
    source: text("source").notNull(),
    rawJson: text("raw_json"),
    importedAt: text("imported_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("purchases_ext_uq").on(t.retailerId, t.externalOrderId),
    index("purchases_ordered_idx").on(t.orderedAt),
  ],
);

export const purchaseItems = sqliteTable(
  "purchase_items",
  {
    id: id(),
    purchaseId: integer("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    lineKey: text("line_key").notNull(),
    productId: integer("product_id").references(() => storeProducts.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    qty: real("qty").notNull().default(1),
    unitPriceCents: integer("unit_price_cents"),
    totalCents: integer("total_cents"),
  },
  (t) => [uniqueIndex("purchase_items_line_uq").on(t.purchaseId, t.lineKey)],
);

export const ingestRuns = sqliteTable("ingest_runs", {
  id: id(),
  clientId: integer("client_id").references(() => apiClients.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  received: integer("received").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errorsJson: text("errors_json").notNull().default("[]"),
  at: text("at").notNull().default(now),
});
