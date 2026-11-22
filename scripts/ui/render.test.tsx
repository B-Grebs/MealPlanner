// UI smoke check: renders every screen in jsdom against a local API.
// Run: npm run dev:api (in another shell), then npm run check:ui
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import App from "../../src/App";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8787";
const realFetch = globalThis.fetch;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function api(method: string, path: string, body?: unknown) {
  const r = await realFetch(BASE + "/api" + path, {
    method,
    headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const errors: string[] = [];

async function render(path: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
}
async function waitFor(fn: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await act(async () => new Promise((r) => setTimeout(r, 50)));
  }
  throw new Error(`timed out waiting for ${what}. Page text: ${container.textContent?.slice(0, 400)}`);
}
const text = () => container.textContent ?? "";
const button = (label: string | RegExp) => {
  const b = [...container.querySelectorAll("button")].find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
  if (!b) throw new Error(`no button ${label}. Buttons: ${[...container.querySelectorAll("button")].map((x) => x.textContent).join(" | ")}`);
  return b as HTMLButtonElement;
};
const click = async (el: Element) => act(async () => (el as HTMLElement).click());
const settled = () => !container.querySelector(".loading");
const noError = () => {
  const e = container.querySelector(".error-box");
  if (e) throw new Error("error box: " + e.textContent);
};

let listId = 0;
let recipeId = 0;

beforeAll(async () => {
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? BASE + input : input;
    return realFetch(url, { ...init, redirect: "follow" });
  }) as typeof fetch;
  window.confirm = () => true;
  const origError = console.error;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
    origError(...a);
  });
  // Seed: a few recipes and an active plan for this month.
  const stamp = Date.now();
  const imp = await api(
    "POST",
    "/import/recipes",
    `# UI Tacos ${stamp}\nservings: 4\ntags: tacos\n- 1 lb ground beef\n- 8 tortillas\n- 1 cup cheddar\nBrown the beef.\n---\n# UI Pasta ${stamp}\ntags: pasta\n- 1 lb spaghetti\n- 1 jar marinara\n---\n# UI Soup ${stamp}\n- 2 cups broth\n- 1 onion`,
  );
  recipeId = imp.created[0].id;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const plans = await api("GET", `/plans?month=${month}`);
  let plan = plans.find((p: any) => p.status === "active");
  if (!plan) {
    plan = await api("POST", "/plans", { month, name: "UI plan" });
    await api("POST", `/plans/${plan.id}/activate`);
  }
  await api("POST", `/plans/${plan.id}/generate`, { seed: 42 });
  const today = `${month}-${String(now.getDate()).padStart(2, "0")}`;
  const l = await api("POST", "/lists", { start: today, end: today, includeStaples: true });
  listId = l.id;
  await api("POST", `/lists/${listId}/items`, { text: "paper towels" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(errors, errors.join("\n")).toEqual([]);
});

describe("screens", () => {
  it("plan: calendar, day editor, lock", async () => {
    await render("/");
    await waitFor(() => container.querySelectorAll(".day").length >= 28, "calendar days");
    noError();
    const firstDay = container.querySelector(".day-main") as HTMLElement;
    await click(firstDay);
    await waitFor(() => !!document.querySelector(".sheet"), "day editor");
    const sheet = document.querySelector(".sheet")!;
    expect(sheet.textContent).toMatch(/Leftovers|Eat out/);
    const close = sheet.querySelector('button[aria-label="Close"]') as HTMLElement | null;
    if (close) await click(close);
    const lock = container.querySelector(".lock") as HTMLElement;
    await click(lock);
    await waitFor(() => !!container.querySelector(".lock.on"), "lock on");
    await click(container.querySelector(".lock.on")!);
  });

  it("recipes: list, detail, edit", async () => {
    await render("/recipes");
    await waitFor(() => /UI Tacos/.test(text()), "recipe list");
    noError();
    await click(container.querySelector(`a[href="/recipes/${recipeId}"]`)!);
    await waitFor(() => /ground beef/i.test(text()), "recipe detail");
    await click(button("+"));
    await waitFor(() => /5 servings/.test(text()), "scaled servings");
    await act(async () => root.unmount());
    container.remove();
    await render(`/recipes/${recipeId}/edit`);
    await waitFor(() => !!container.querySelector(".ing-row"), "edit form");
    noError();
  });

  it("new recipe and import screens render", async () => {
    await render("/recipes/new");
    await waitFor(() => !!container.querySelector("form, .ing-rows"), "new recipe form");
    noError();
    await act(async () => root.unmount());
    container.remove();
    await render("/recipes/import");
    await waitFor(() => /Import recipes/.test(text()), "import page");
    await click(button("Use the example"));
    await click(button("Preview"));
    await waitFor(() => /Chicken Tacos/.test(text()) && /Import \d|Nothing new/.test(text()), "import preview");
  });

  it("lists: index and check-off", async () => {
    await render("/lists");
    await waitFor(() => /Make list/.test(text()) && settled(), "lists page");
    noError();
    await act(async () => root.unmount());
    container.remove();
    await render(`/lists/${listId}`);
    await waitFor(() => /paper towels/i.test(text()), "list items");
    const box = container.querySelector(".items input[type=checkbox]") as HTMLInputElement;
    await click(box);
    await waitFor(() => !!container.querySelector(".items li.checked"), "checked item");
    const fresh = await api("GET", `/lists/${listId}`);
    expect(fresh.items.some((i: any) => i.checked)).toBe(true);
  });

  it("settings tabs render", async () => {
    for (const p of ["/settings", "/settings/ingredients", "/settings/aisles", "/settings/integrations", "/settings/store"]) {
      await render(p);
      await waitFor(() => settled() && text().length > 50, `settings ${p}`);
      noError();
      await act(async () => root.unmount());
      container.remove();
    }
    await render("/settings");
  });
});
