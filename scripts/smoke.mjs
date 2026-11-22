// End-to-end check against `wrangler dev` with DEV_AUTH_EMAIL set (.dev.vars).
// Usage: npm run dev:api (in another terminal), then npm run smoke
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
let failures = 0;

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

function check(name, cond, extra) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 400));
  }
}

// Same local date the Worker uses (APP_TZ).
const today = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TZ ?? "America/Chicago" }).format(new Date());
const month = today.slice(0, 7);

const me = await call("GET", "/api/me");
check("me", me.status === 200 && me.json.kind === "user", me.json);

const paste = `# Smoke Tacos
servings: 4
prep: 10
cook: 15
tags: tacos, quick
note: thaw the chicken
## Ingredients
- 1 lb chicken thighs, diced
- 1 packet taco seasoning
- 8 small tortillas
- 1 cup shredded cheddar
- salt, to taste
## Steps
1. Cook.
---
# Smoke Pasta
servings: 4
- 1 lb spaghetti
- 1 jar marinara
- 1/2 cup shredded cheddar
Boil.
---
# Smoke Stir Fry
servings: 2
- 12 oz chicken thighs
- 2 cups broccoli
- 2 tbsp soy sauce
Fry.`;

const dry = await call("POST", "/api/import/recipes?dryRun=1", paste);
check("import dry run parses 3", dry.status === 200 && dry.json.recipes.length === 3 && dry.json.created.length === 0, dry.json);
const imp = await call("POST", "/api/import/recipes", paste);
check("import creates", imp.status === 201 && imp.json.created.length >= 0, imp.json);
const imp2 = await call("POST", "/api/import/recipes", paste);
check("re-import skips duplicates", imp2.status === 201 && imp2.json.created.length === 0, imp2.json);

const list = await call("GET", "/api/recipes?q=smoke");
check("recipe search", list.status === 200 && list.json.length >= 3, list.json);
const tacos = list.json.find((r) => r.title === "Smoke Tacos");
const one = await call("GET", `/api/recipes/${tacos.id}`);
check("recipe detail has ingredients", one.json.ingredients.length === 5 && one.json.tags.includes("tacos"), one.json);
check("recipe ingredients carry names and aisles", one.json.ingredients.every((i) => typeof i.name === "string" && i.name && (i.aisle === null || typeof i.aisle === "string")), one.json.ingredients);

const upd = await call("PUT", `/api/recipes/${tacos.id}`, {
  ...one.json,
  favorite: true,
  ingredients: [...one.json.ingredients.map((i) => ({ ingredient_id: i.ingredient_id, qty: i.qty, unit: i.unit, note: i.note })), { name: "lime", qty: 1 }],
});
check("recipe update", upd.status === 200 && upd.json.favorite === true && upd.json.ingredients.length === 6, upd.json);

const auto = await call("GET", "/api/ingredients?q=ched");
check("ingredient autocomplete", auto.json[0]?.name === "shredded cheddar", auto.json);
const aisles = await call("GET", "/api/aisles");
const dairy = aisles.json.find((a) => a.name === "Dairy & Eggs");
const setAisle = await call("PUT", `/api/ingredients/${auto.json[0].id}`, { aisle_id: dairy.id });
check("set ingredient aisle", setAisle.json.aisle === "Dairy & Eggs", setAisle.json);
const salt = (await call("GET", "/api/ingredients?q=salt")).json[0];
await call("PUT", `/api/ingredients/${salt.id}`, { is_staple: true });

const plan = await call("POST", "/api/plans", { month });
check("create plan", plan.status === 201 && plan.json.month === month, plan.json);
const pid = plan.json.id;
const gen = await call("POST", `/api/plans/${pid}/generate`, { seed: 123 });
check("generate fills days", gen.status === 200 && gen.json.entries.length > 20 && gen.json.seed === 123, gen.json);
const gen2 = await call("POST", `/api/plans/${pid}/generate`, { seed: 123 });
check(
  "same seed same plan",
  JSON.stringify(gen.json.entries.map((e) => e.recipe_id)) === JSON.stringify(gen2.json.entries.map((e) => e.recipe_id)),
);
const set = await call("PUT", `/api/plans/${pid}/entries`, { date: today, recipe_id: tacos.id, locked: true });
const todayEntry = set.json.entries.find((e) => e.date === today);
check("set + lock a day", todayEntry?.recipe_id === tacos.id && todayEntry.locked, todayEntry);
const gen3 = await call("POST", `/api/plans/${pid}/generate`, {});
check("regenerate keeps locked day", gen3.json.entries.find((e) => e.date === today)?.recipe_id === tacos.id);
const ff = await call("PUT", `/api/plans/${pid}/entries`, { date: `${month}-01`, freeform_text: "Leftovers" });
check("freeform day", ff.json.entries.find((e) => e.date === `${month}-01`)?.freeform_text === "Leftovers");

const nextMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 7);
const copy = await call("POST", `/api/plans/${pid}/copy`, { targetMonth: nextMonth });
check("copy to next month", copy.status === 201 && copy.json.month === nextMonth && copy.json.entries.length > 15, copy.json);

const ha = await call("GET", "/api/ha/today");
check("ha today", ha.status === 200 && ha.json.dinner === "Smoke Tacos" && ha.json.prep_note === "thaw the chicken", ha.json);

const sl = await call("POST", "/api/lists", { start: today, end: today });
check("list generated", sl.status === 201 && sl.json.items.length >= 4, sl.json);
check("staple excluded", !sl.json.items.some((i) => i.text === "salt"));
const ched = sl.json.items.find((i) => i.text === "shredded cheddar");
check("cheddar in dairy", ched?.aisle === "Dairy & Eggs", ched);
const chk = await call("PATCH", `/api/lists/${sl.json.id}/items/${ched.id}`, { checked: true });
check("check off", chk.json.items.find((i) => i.id === ched.id)?.checked === true);
await call("POST", `/api/lists/${sl.json.id}/items`, { text: "paper towels" });
const regen = await call("POST", `/api/lists/${sl.json.id}/regenerate`, {});
check(
  "regenerate keeps manual + checked",
  regen.json.items.some((i) => i.text === "paper towels" && i.manual) && regen.json.items.find((i) => i.text === "shredded cheddar")?.checked === true,
  regen.json.items,
);

const week = await call("POST", "/api/lists", {});
const chickens = week.json.items.filter((i) => i.text === "chicken thighs");
check("week list aggregates", week.status === 201 && chickens.length === 1, week.json.items);

// Clients and ingest
const noClient = await call("GET", "/api/ha/today", undefined, { "X-Dev-Client": "unknown.access" });
check("unregistered token refused", noClient.status === 403, noClient.json);
await call("POST", "/api/clients", { name: "Home Assistant", client_id: "ha-smoke.access", scopes: ["ha"] });
await call("POST", "/api/clients", { name: "Rig agent", client_id: "rig-smoke.access", scopes: ["ingest"] });
const haTok = await call("GET", "/api/ha/today", undefined, { "X-Dev-Client": "ha-smoke.access" });
check("ha token reads today", haTok.status === 200, haTok.json);
const haBad = await call("GET", "/api/recipes", undefined, { "X-Dev-Client": "ha-smoke.access" });
check("ha token can't read recipes", haBad.status === 403);
const haIngest = await call("POST", "/api/ingest/products", { retailer: "target", items: [] }, { "X-Dev-Client": "ha-smoke.access" });
check("ha token can't ingest", haIngest.status === 403);

const rig = { "X-Dev-Client": "rig-smoke.access" };
const prodBody = {
  retailer: "target",
  items: [
    { external_id: "T1", name: "Shredded Cheddar 8oz", brand: "Good & Gather", size_text: "8 oz", pack_qty: 8, pack_unit: "oz", price: { price_cents: 299, observed_at: "2026-11-21T18:00:00Z" } },
    { external_id: "T2", name: "Yellow Onions 3lb", price: { price_cents: 349, observed_at: "2026-11-21T18:00:00Z" } },
    { name: "missing id" },
  ],
};
const p1 = await call("POST", "/api/ingest/products", prodBody, rig);
check("ingest products", p1.status === 200 && p1.json.inserted === 2 && p1.json.prices_added === 2 && p1.json.errors.length === 1, p1.json);
const p2 = await call("POST", "/api/ingest/products", prodBody, rig);
check("ingest is idempotent", p2.json.inserted === 0 && p2.json.updated === 2 && p2.json.prices_added === 0, p2.json);
const order = {
  retailer: "costco",
  orders: [{ external_order_id: "W1", ordered_at: "2026-11-20T15:00:00Z", total_cents: 1598, items: [{ external_id: "C9", name: "Eggs 24ct", qty: 1, total_cents: 899 }, { name: "Bananas", qty: 1, total_cents: 699 }] }],
};
const o1 = await call("POST", "/api/ingest/purchases", order, rig);
check("ingest purchases", o1.status === 200 && o1.json.inserted === 1 && o1.json.items === 2, o1.json);
const o2 = await call("POST", "/api/ingest/purchases", order, rig);
check("purchases idempotent", o2.json.inserted === 0 && o2.json.updated === 1, o2.json);
const prods = await call("GET", "/api/store-products?retailer=target");
const cheddarProd = prods.json.find((p) => p.external_id === "T1");
check("products listed with price", cheddarProd?.price_cents === 299, prods.json);
const link = await call("PUT", `/api/ingredients/${ched.ingredient_id}/products/${cheddarProd.id}`, { preferred: true });
check("link ingredient to product", link.status === 200);
const wanted = await call("GET", "/api/ingest/wanted?retailer=target", undefined, rig);
const w = wanted.json.find?.((x) => x.name === "shredded cheddar");
check("wanted includes linked product", w?.products?.[0]?.external_id === "T1", wanted.json);
const purchasesList = await call("GET", "/api/purchases");
check("purchases listed", purchasesList.json.some((p) => p.external_order_id === "W1" && p.items === 2), purchasesList.json);

// Calendar feed
const ft = await call("POST", "/api/feed-tokens", { name: "HA calendar" });
check("feed token created", ft.status === 201 && ft.json.token.length > 30, ft.json);
const ics = await call("GET", `/api/calendar.ics?token=${ft.json.token}`);
check("ics feed", ics.status === 200 && ics.text.includes("SUMMARY:Smoke Tacos"), ics.text.slice(0, 300));
const icsBad = await call("GET", "/api/calendar.ics?token=nope");
check("ics bad token refused", icsBad.status === 401);

const badJson = await fetch(BASE + "/api/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
check("bad json is 400", badJson.status === 400);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
