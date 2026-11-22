// Thin JSON client. Cloudflare Access answers an expired session with a redirect
// to its login page, which fetch can't follow cross-origin; surface that as SessionExpired.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export class SessionExpired extends ApiError {
  constructor() {
    super(401, "Your sign-in has expired.");
  }
}

const listeners = new Set<() => void>();
export function onSessionExpired(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      redirect: "manual",
      credentials: "same-origin",
      headers: body === undefined ? undefined : typeof body === "string" ? { "Content-Type": "text/plain" } : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  if (res.type === "opaqueredirect" || res.status === 401) {
    listeners.forEach((f) => f());
    throw new SessionExpired();
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
export const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const del = <T = any>(p: string) => api<T>("DELETE", p);

// ---------------------------------------------------------------- types

export interface Recipe {
  id: number;
  title: string;
  description: string | null;
  servings: number;
  prep_min: number | null;
  cook_min: number | null;
  total_min: number | null;
  instructions_md: string | null;
  source_url: string | null;
  prep_note: string | null;
  favorite: boolean;
  archived: boolean;
  tags: string[];
}
export interface RecipeIngredient {
  id?: number;
  ingredient_id: number | null;
  name: string;
  qty: number | null;
  unit: string;
  note: string | null;
  aisle?: string | null;
  is_staple?: boolean;
}
export interface RecipeFull extends Recipe {
  ingredients: RecipeIngredient[];
}
export interface Ingredient {
  id: number;
  name: string;
  aisle_id: number | null;
  aisle: string | null;
  is_staple: boolean;
  default_unit: string | null;
  uses?: number;
}
export interface Aisle {
  id: number;
  name: string;
  sort: number;
}
export interface PlanEntry {
  id: number;
  date: string;
  slot: string;
  recipe_id: number | null;
  recipe_title: string | null;
  freeform_text: string | null;
  servings_override: number | null;
  locked: boolean;
  notes: string | null;
}
export interface Plan {
  id: number;
  month: string;
  name: string;
  status: "draft" | "active";
  parent_plan_id: number | null;
  last_seed: number | null;
  entry_count?: number;
  entries?: PlanEntry[];
  warnings?: string[];
  seed?: number;
}
export interface ListSummary {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: "open" | "done";
  total: number;
  checked: number;
}
export interface ListItem {
  id: number;
  ingredient_id: number | null;
  text: string;
  qty: number | null;
  unit: string;
  aisle: string | null;
  checked: boolean;
  manual: boolean;
}
export interface ShoppingList extends ListSummary {
  include_staples: boolean;
  aisle_order: string[];
  items: ListItem[];
}
export interface Rule {
  id: number;
  name: string;
  kind: string;
  config: Record<string, any>;
  active: boolean;
  sort: number;
}
