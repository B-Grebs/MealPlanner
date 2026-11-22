# Greb Meals — Architecture

Version 0.2 (Nov 22, 2026). Rewritten from the v0.1 draft. Host: `meals.greb.party`.

This is the design of record. Anything marked **Default** was an open question in v0.1; it is what the code does today and can be changed.

---

## 1. Scope

### Phase 1 (built)
1. **Recipes**: store, edit, tag, search, favourite, archive. Canonical ingredients with aisles. Bulk paste import.
2. **Monthly plan**: build a month of dinners, then iterate: copy the previous month, lock what you like, regenerate the rest with a seeded rule-based filler, hand-edit any day, activate.
3. **Shopping lists**: generate from a date range of the active plan(s), aggregated by ingredient and unit, grouped by aisle in store order, check off on a phone, add manual items, regenerate without losing manual items or checks.
4. **External data feeds** (schema + API, no feeder yet): authenticated ingest for retailer products, prices and order history (Target, Amazon, Costco), and links from canonical ingredients to store products. See §7.

### Phase 1.5 (built, cheap pieces)
- `GET /api/calendar.ics`: active plans as an ICS feed (HA Remote Calendar, Google Calendar, DAKboard).
- `GET /api/ha/today`: tonight's dinner for a Home Assistant REST sensor.

### Later
- Recipe import from a URL (schema.org JSON-LD `Recipe`)
- Pantry tracking (subtract what you have; fed by purchases, §7)
- Kids vote on meals
- LLM planning on the local GPU rig ("plan next week from what's in the fridge"), as just another API client
- Shopping list → HA to-do sync, Grebflix tile, Google Home announcements
- Price-aware lists ("cheapest store for this list") once feeds exist

### Non-goals (for now)
Nutrition and macros, multi-household, public sharing, scraping retailer sites from the Worker.

---

## 2. Decisions on the v0.1 open questions

| # | Question | Default | How to change |
|---|---|---|---|
| 1 | Slots | **Dinner only in the UI.** The schema keeps `slot` (`breakfast`/`lunch`/`dinner`/`snack`), so adding lunches later is UI work only. | Add slot tabs to the plan view. |
| 2 | Editors | **Everyone on the Access allow-list can edit.** No roles. Users are created on first visit from the Access email. | Add `users.role` and a check in the auth middleware. |
| 3 | Repo | **Standalone repo** (`B-Grebs/MealPlanner`). It is not a game, and it has a database. | — |
| 4 | Frontend | **React + Vite** (TypeScript), plain CSS, no UI kit. | — |
| 5 | Seed data | **Bulk paste import** (§6.4). No import from another app. | Add a parser for the source format. |
| 6 | Build vs Mealie | Build. The rule-driven monthly iteration and store data feeds are the point. | — |

One deliberate change from v0.1: **one Worker with static assets instead of Pages + a separate Worker.** The React build is served by the same Worker that serves `/api/*`. One deploy, one domain, no CORS, and it deploys from `main` with Cloudflare Workers Builds exactly like the greb.party games.

---

## 3. Architecture

```
 Phone / tablet / PC (PWA)          Home Assistant (Pi 4)        Local agent (rig) / other feeders
          │ HTTPS                     │ service token              │ service token (one per source)
          ▼                           ▼                            ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Cloudflare Access  (Google sign-in, family allow-list; service tokens)    │
 │   Bypass app on /api/calendar.ics only (secret-URL token instead)         │
 └───────────────────────────────────┬──────────────────────────────────────┘
                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Worker "greb-meals"  (Hono, TypeScript)                                   │
 │   /api/*            JSON API  (verifies the Access JWT itself)            │
 │   /*                static assets: React PWA (SPA fallback)               │
 └───────────────────────────────────┬──────────────────────────────────────┘
                                     ▼
                   D1 "greb-meals" (SQLite) + Drizzle migrations in /drizzle
                   R2 for recipe photos (later)
```

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + Vite PWA, served as Worker static assets | Installable on phones; works in the store |
| API | Cloudflare Worker + Hono | Same platform as greb.party; free tier |
| DB | D1 + Drizzle ORM; SQL migrations committed in `drizzle/` | Relational data; migrations in git, applied on deploy |
| Auth | Cloudflare Access (Zero Trust) | No login code in the app |
| Machines | Access **service tokens** | HA and feeders send `CF-Access-Client-Id` / `CF-Access-Client-Secret` |
| Deploy | Workers Builds on push to `main`: `npm run deploy` | Same as the games |

### 3.1 Auth model

Access sits in front of the whole hostname. The Worker does **not** just trust a header: it verifies the `Cf-Access-Jwt-Assertion` JWT against the team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) and the application's AUD tag (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` vars). Requests resolve to one of two principals:

- **User**: the JWT has an `email`. Looked up in `users`, created on first visit. Can use every user endpoint.
- **Client**: a service-token JWT has `common_name` = the token's Client ID and no email. Looked up in `api_clients` by `client_id`. Each client has scopes: `ha` (read today/plan), `ingest` (write store data), `read` (read the JSON API). Unknown Client IDs get 403 even if Access let them through, so registering a token in Access is not enough; it must also be registered in the app (Settings → API clients). This keeps one feeder from impersonating another, and lets ingest rows record their `source`.

Fail closed: if `ACCESS_AUD` is not set, every `/api` request is rejected, unless `DEV_AUTH_EMAIL` is set (local `wrangler dev` only, via `.dev.vars`; never set in production).

**Calendar feed exception.** Calendar apps (HA Remote Calendar, Google Calendar) cannot send headers, so `/api/calendar.ics` sits behind an Access **Bypass** application for that one path and is protected by a long random token in the URL (`?token=…`). Tokens are created in Settings, shown once, stored as SHA-256 hashes in `feed_tokens`, and can be revoked. The feed exposes only dates and meal names.

---

## 4. Data model

All tables in `worker/db/schema.ts`; migrations in `drizzle/`. Times are ISO-8601 UTC text; plan dates are local `YYYY-MM-DD` (America/Chicago, `APP_TZ`).

### 4.1 Core

```sql
users              (id, email UNIQUE, name, created_at)

aisles             (id, name UNIQUE, sort)               -- store walk order
ingredients        (id, name UNIQUE COLLATE NOCASE, aisle_id → aisles, is_staple, default_unit)
tags               (id, name UNIQUE COLLATE NOCASE)

recipes            (id, title, description, servings, prep_min, cook_min,
                    instructions_md, source_url, photo_key, prep_note,
                    favorite, archived, created_by → users, created_at, updated_at)
recipe_tags        (recipe_id, tag_id)  PK(recipe_id, tag_id)
recipe_ingredients (id, recipe_id, ingredient_id, qty NULL, unit, note, sort)

meal_plans         (id, month 'YYYY-MM', name, status 'draft'|'active',
                    parent_plan_id NULL, last_seed NULL, created_at, updated_at)
plan_entries       (id, plan_id, date, slot,
                    recipe_id NULL, freeform_text NULL,   -- "Leftovers", "Eat out"
                    servings_override NULL, locked, notes)
                    UNIQUE(plan_id, date, slot)
plan_rules         (id, name, kind, config_json, active, sort)

shopping_lists     (id, name, start_date, end_date, include_staples, status 'open'|'done', created_at)
shopping_items     (id, list_id, ingredient_id NULL, text, qty NULL, unit, aisle,
                    checked, manual, source_entry_ids_json, sort)
```

Notes:
- **Canonical ingredients** are what make aggregation work ("2 onions" + "1 onion" = 3). The editor autocompletes against `ingredients` and creates a new one when nothing matches.
- **`freeform_text`** handles nights with no recipe (leftovers, pizza night out).
- **`parent_plan_id`** records where a copied month came from.
- **`is_staple`** items (salt, oil) are left off generated lists unless "include staples" is on.
- **`prep_note`** ("thaw the chicken") feeds the HA sensor so an automation can remind the night before.
- Only one plan per month can be `active`; activating one sets the others back to `draft`.

### 4.2 Machine clients

```sql
api_clients   (id, name, client_id UNIQUE, scopes 'ha,ingest,read', active, created_at, last_seen_at)
feed_tokens   (id, name, token_hash UNIQUE, created_at, last_used_at, revoked)
```

---

## 5. Iterating the monthly plan

1. **Start** a month: an empty draft, or **copy** a previous month.
2. **Lock** the days you like.
3. **Regenerate** the unlocked days, as often as you want.
4. **Hand-edit** a day: pick a recipe, type freeform text, set servings, add a note.
5. **Activate**. The active plan is what lists, HA and the calendar feed read.

**Copy** maps by "nth weekday of the month": the 2nd Tuesday of October lands on the 2nd Tuesday of November, so Taco Tuesday stays Tuesday. A 5th weekday that doesn't exist in the target month is dropped. Locks are carried over.

**Generate** is a constraint filler (no AI in Phase 1), seeded so a regenerate can be reproduced (`last_seed` is stored and returned). For each unlocked dinner, in date order:

1. Apply `fixed_freeform` (e.g. Friday → "Pizza night"): the day gets that text, no recipe.
2. Candidates = non-archived recipes with at least one ingredient or instruction.
3. Hard filters: `no_repeat_within` (against this plan, and the previous month's active plan), `weekday_max_time` (prep + cook), `weekday_theme` (only recipes with the tag on that weekday; if none exist, the theme is skipped and a warning is returned).
4. Weights: base 1; favourite × 2; `tag_quota` tags not yet met this week × 3; used in the last 28 days × 0.3.
5. Weighted pick with a seeded PRNG (mulberry32). If every candidate was filtered out, relax `no_repeat_within`; if still none, leave the day empty and warn.

| Rule kind | Example config |
|---|---|
| `weekday_theme` | `{ "weekday": 2, "tag": "tacos" }` (Taco Tuesday; 0 = Sunday) |
| `no_repeat_within` | `{ "days": 14 }` |
| `tag_quota` | `{ "tag": "fish", "per_week": 1 }` |
| `fixed_freeform` | `{ "weekday": 5, "text": "Pizza night" }` |
| `weekday_max_time` | `{ "weekdays": [1,2,3,4], "max_total_min": 40 }` |

---

## 6. Shopping lists

### 6.1 Generation
- **Range**: default the next 7 days (monthly lists don't work for perishables). Reads entries from **active** plans only.
- **Scale** each recipe by `servings_override / recipe.servings`.
- **Aggregate** by `(ingredient, unit family)`:
  - volume (tsp, tbsp, cup, fl oz, ml, l) → summed in ml, shown in cups / tbsp / tsp (or ml / l if every input was metric)
  - weight (oz, lb, g, kg) → summed in grams, shown in lb / oz (or g / kg)
  - count (no unit, "each", "whole") → summed
  - anything else ("can", "clove", "bunch", "packet") → summed per exact unit
  - Different families on one ingredient become separate lines ("2 cups" and "1 can" of tomatoes).
  - A line with no quantity ("salt, to taste") stays a line with no quantity.
- **Exclude staples** unless asked.
- **Group** by aisle in `aisles.sort` order; ingredients without an aisle go under "Other".

### 6.2 Editing
- Check off, uncheck, add manual items ("paper towels"), delete items.
- A generated list is **independent of the plan**. "Regenerate" rebuilds generated lines from the current plan and keeps manual items, and keeps the checked state of lines whose ingredient and unit still match.

### 6.3 Mobile
- Big tap targets, checked items sink to the bottom of their aisle, works as an installed PWA. The list view is cached by the service worker (network-first), so a list that was opened at home still shows in a store with bad signal.

### 6.4 Bulk recipe import
`POST /api/import/recipes` takes either JSON (an array of recipe objects, same shape as `POST /api/recipes`) or a plain-text paste:

```
# Chicken Tacos
servings: 4
prep: 10
cook: 20
tags: tacos, quick, kid-fave
source: https://example.com/tacos
note: thaw the chicken the night before

## Ingredients
- 1 lb chicken thighs, diced
- 1 packet taco seasoning
- 8 small tortillas
- 1 cup shredded cheddar
- salt, to taste

## Steps
1. Brown the chicken.
2. Add seasoning and 2/3 cup water.

---

# Next recipe
...
```

Recipes are separated by `---`. Ingredient lines understand `1`, `1/2`, `1 1/2`, `½`, `1.5`, `1-2` (takes the high end), common units and their spellings, and a note after a comma or in parentheses. `?dryRun=1` returns the parse with warnings and creates nothing; the UI shows that preview before saving. Unknown ingredients are created with no aisle; they show up under Settings → Ingredients to sort.

---

## 7. External data feeds (store products, prices, purchases)

Goal: something outside the app (a local agent on the rig, a browser extension, an export file, a third-party API) can push what the family buys and what things cost into the planner, without the Worker ever scraping a retailer. The app owns the canonical ingredients; feeders own retailer data.

### 7.1 Principles
- **Push, not pull.** The Worker exposes an ingest API. Feeders run wherever they can see the data (signed-in browser, order export emails, CSV downloads).
- **One Access service token per source**, registered in `api_clients` with scope `ingest`. The client's name is stamped as `source` on every row it writes, so a bad feeder can be found and its rows ignored or deleted.
- **Idempotent upserts keyed by source-side ids.** Products by `(retailer, external_id)`, prices by `(product, observed_at, source)`, orders by `(retailer, external_order_id)`, order lines by `(purchase, line_key)`. A feeder can resend the same batch safely, and a crashed run can be retried from the top.
- **History is append-only.** Prices are observations with `observed_at`; nothing overwrites an old price.
- **Raw payloads are kept** (`raw_json`, capped at 8 KB per row) so a parser can be improved later without re-fetching.
- **Batches are bounded**: at most 500 items per request; feeders page.

### 7.2 Tables

```sql
retailers                (id, slug UNIQUE, name)            -- target, amazon, costco (seeded); feeders may add
store_products           (id, retailer_id, external_id,     -- TCIN, ASIN, Costco item #
                          name, brand, size_text, pack_qty, pack_unit,
                          upc, url, image_url, source, first_seen_at, last_seen_at, raw_json)
                          UNIQUE(retailer_id, external_id)
product_prices           (id, product_id, price_cents, currency, unit_price_cents NULL,
                          in_stock NULL, store_ref NULL, observed_at, source)
                          UNIQUE(product_id, observed_at, source)
ingredient_product_links (ingredient_id, product_id, preferred, created_at, created_by)
                          PK(ingredient_id, product_id)
purchases                (id, retailer_id, external_order_id, ordered_at, total_cents NULL,
                          currency, source, raw_json, imported_at)
                          UNIQUE(retailer_id, external_order_id)
purchase_items           (id, purchase_id, line_key, product_id NULL, name, qty, unit_price_cents NULL,
                          total_cents NULL)
                          UNIQUE(purchase_id, line_key)
ingest_runs              (id, client_id, kind, received, inserted, updated, skipped, errors_json, at)
```

`pack_qty` + `pack_unit` ("2 lb", "24 count") are what will let a future step turn "3 lb onions needed" into "buy two 2 lb bags" and compute unit prices. Pantry (later) is derived from `purchase_items` linked to ingredients, minus what plans consume.

### 7.3 Ingest API (scope `ingest`)

```
POST /api/ingest/products
{
  "retailer": "target",                     // slug; unknown slugs are created if "retailerName" is given
  "items": [{
    "external_id": "12345678",              // required
    "name": "Good & Gather Yellow Onions, 3 lb Bag",   // required
    "brand": "Good & Gather", "size_text": "3 lb", "pack_qty": 3, "pack_unit": "lb",
    "upc": "...", "url": "...", "image_url": "...",
    "price": { "price_cents": 349, "currency": "USD", "observed_at": "2026-11-21T18:00:00Z",
               "in_stock": true, "store_ref": "T-1234" },   // optional; appended to history
    "raw": { ... }                          // optional
  }]
}
→ 200 { "received": 1, "inserted": 1, "updated": 0, "prices_added": 1, "skipped": 0, "errors": [] }

POST /api/ingest/purchases
{
  "retailer": "costco",
  "orders": [{
    "external_order_id": "W123-456",        // required
    "ordered_at": "2026-11-20T15:04:00Z",   // required
    "total_cents": 21455, "currency": "USD",
    "items": [{
      "line_key": "1",                      // stable within the order; defaults to the item's index
      "external_id": "987654",              // links to store_products if known (created if name given)
      "name": "Kirkland Organic Eggs, 24 ct", "qty": 1, "unit_price_cents": 899, "total_cents": 899
    }],
    "raw": { ... }
  }]
}
→ 200 { "received": 1, "inserted": 1, "updated": 0, "items": 1, "errors": [] }

GET  /api/ingest/wanted?retailer=target
→ canonical ingredients on open lists and upcoming active plans, with any linked products for that
  retailer, so a feeder knows what to price-check next.

GET  /api/ingest/runs        (user)  recent ingest runs, for debugging feeders
```

Per-item validation errors are reported in `errors` (with the index) and don't fail the batch.

### 7.4 User endpoints for store data
```
GET    /api/retailers
GET    /api/store-products?q=&retailer=          search, with latest price
GET    /api/ingredients/:id/products              linked products + latest prices
PUT    /api/ingredients/:id/products/:productId   { preferred }  link
DELETE /api/ingredients/:id/products/:productId   unlink
GET    /api/purchases?retailer=&limit=            order history
```

### 7.5 What a feeder looks like (not built)
A small script or agent on the rig with the service token in its own secret store:
1. `GET /api/ingest/wanted` to learn what to look up.
2. Read prices from wherever it has legitimate access (the retailer's own API where one exists, order confirmation emails, exported order CSVs).
3. `POST /api/ingest/products` and `/purchases` in batches of ≤ 500.
Scraping retailer sites is out of scope for this repo.

---

## 8. API

All under `/api`, JSON, user principal unless noted.

```
GET             /api/me
GET/POST        /api/recipes                 ?q=&tag=&archived=
GET/PUT/DELETE  /api/recipes/:id             (DELETE archives)
POST            /api/import/recipes          ?dryRun=1   text or JSON
GET             /api/ingredients             ?q=   (autocomplete)
PUT             /api/ingredients/:id         { aisle_id, is_staple, name }
GET             /api/tags
GET/PUT         /api/aisles                  (PUT replaces the order)

GET/POST        /api/plans                   ?month=
GET/DELETE      /api/plans/:id
POST            /api/plans/:id/copy          { targetMonth }
POST            /api/plans/:id/generate      { seed? }
PUT             /api/plans/:id/entries       { date, slot?, recipe_id?, freeform_text?, locked?, servings_override?, notes? }
DELETE          /api/plans/:id/entries/:entryId
POST            /api/plans/:id/activate
GET/POST        /api/rules ; PUT/DELETE /api/rules/:id

GET/POST        /api/lists                   { start, end, includeStaples, name? }
GET/DELETE      /api/lists/:id
POST            /api/lists/:id/regenerate
POST            /api/lists/:id/items         { text, qty?, unit?, aisle? }
PATCH/DELETE    /api/lists/:id/items/:itemId { checked }

GET/POST        /api/clients ; PUT/DELETE /api/clients/:id     (register service tokens)
GET/POST        /api/feed-tokens ; DELETE /api/feed-tokens/:id

# integrations
GET  /api/ha/today        (scope ha)  → { date, dinner, recipe_id, freeform, prep_note, tomorrow: {...} }
GET  /api/ha/week         (scope ha)  → next 7 days
GET  /api/calendar.ics    ?token=     → active plans as all-day events
# ingest: §7.3
```

---

## 9. Home Assistant

```yaml
# configuration.yaml
rest:
  - resource: https://meals.greb.party/api/ha/today
    headers:
      CF-Access-Client-Id: !secret meals_client_id
      CF-Access-Client-Secret: !secret meals_client_secret
    scan_interval: 900
    sensor:
      - name: Dinner tonight
        unique_id: meals_dinner_tonight
        value_template: "{{ value_json.dinner or 'Nothing planned' }}"
        json_attributes: [date, recipe_id, prep_note, tomorrow]
```

- **Calendar**: add the Remote Calendar integration with `https://meals.greb.party/api/calendar.ics?token=…` (token from Settings).
- **Automations**: 4 pm announce `sensor.dinner_tonight` on the Google Homes; 8 pm announce `tomorrow.prep_note` when it's set (thaw reminder).

---

## 10. Deploy and operations

- `wrangler.jsonc` defines the Worker `greb-meals`, the static assets (`dist/`, SPA fallback, `/api/*` goes to the Worker first) and the D1 binding `DB`.
- **Workers Builds** on push to `main` runs `npm ci` then `npm run deploy` = build, `wrangler d1 migrations apply DB --remote`, `wrangler deploy`. Migrations must be backward compatible with the previous Worker for the few seconds between the two steps (add columns, don't rename).
- **Custom domain** `meals.greb.party` on the Worker.
- **Access**: one self-hosted application on `meals.greb.party` (Google login, allow-list of family emails, plus a Service Auth policy for the HA and feeder tokens), and one Bypass application on `meals.greb.party/api/calendar.ics`. The AUD tag and team domain go in `wrangler.jsonc` vars (not secrets; they are public identifiers).
- **Secrets**: none needed by the Worker today. Service token secrets live in Access and in the clients (HA `secrets.yaml`, the feeder's own store), never in this repo.
- **Local dev**: `npm install`, `cp .dev.vars.example .dev.vars`, `npm run dev` → Vite on :5173 proxying `/api` to `wrangler dev` on :8787 with a local D1. `npm test` runs the unit tests; `npm run smoke` runs an end-to-end check against `wrangler dev`.

---

## 11. Phases

| Phase | Deliverable | Status |
|---|---|---|
| 1a | Repo, D1 schema + migrations, Access, recipe CRUD with ingredient autocomplete, bulk import | built |
| 1b | Month view, copy previous month, manual editing, lock, activate | built |
| 1c | Rule-based generate / regenerate | built |
| 1d | Shopping lists, aisle grouping, check-off (mobile-first) | built |
| 1e | Store data schema + ingest API (§7) | built, no feeder |
| 1.5 | ICS feed, HA sensor endpoints | built; URL recipe import later |
| 2+ | Feeder on the rig, pantry, price-aware lists, kid voting, LLM planner, Grebflix tile | later |
