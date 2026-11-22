// Rule-based plan filler (ARCHITECTURE §5). Pure: no database access.
import { daysBetween, weekday, weekKey } from "./dates";

export interface GenRecipe {
  id: number;
  title: string;
  tags: string[];
  totalMin: number | null;
  favorite: boolean;
}

export interface GenRule {
  kind: string;
  config: Record<string, unknown>;
}

export interface GenEntry {
  date: string;
  recipeId: number | null;
  freeformText: string | null;
  locked: boolean;
}

export interface GenResult {
  /** One assignment per unlocked date, in date order. */
  assignments: Array<{ date: string; recipeId: number | null; freeformText: string | null }>;
  warnings: string[];
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/**
 * Fill every unlocked date in `dates`.
 * `existing` holds this plan's current entries (locked ones are kept as-is).
 * `history` holds recent meals from before this plan (e.g. last month's active plan),
 * used for no-repeat and recency weighting.
 */
export function generatePlan(opts: {
  dates: string[];
  existing: GenEntry[];
  history: Array<{ date: string; recipeId: number }>;
  recipes: GenRecipe[];
  rules: GenRule[];
  seed: number;
}): GenResult {
  const { dates, existing, history, recipes, rules, seed } = opts;
  const rand = mulberry32(seed);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (w: string) => {
    if (!warned.has(w)) {
      warned.add(w);
      warnings.push(w);
    }
  };

  const byDate = new Map(existing.map((e) => [e.date, e]));
  // Everything already decided, used for no-repeat and quotas. Starts with locked days.
  const used: Array<{ date: string; recipeId: number }> = [...history];
  for (const e of existing) if (e.locked && e.recipeId) used.push({ date: e.date, recipeId: e.recipeId });

  const noRepeat = rules
    .filter((r) => r.kind === "no_repeat_within")
    .reduce((m, r) => Math.max(m, num(r.config.days, 0)), 0);
  const themes = rules.filter((r) => r.kind === "weekday_theme");
  const quotas = rules.filter((r) => r.kind === "tag_quota");
  const freeforms = rules.filter((r) => r.kind === "fixed_freeform");
  const maxTimes = rules.filter((r) => r.kind === "weekday_max_time");

  if (!recipes.length) warn("There are no recipes yet, so nothing could be planned.");

  const assignments: GenResult["assignments"] = [];
  for (const date of [...dates].sort()) {
    const cur = byDate.get(date);
    if (cur?.locked) continue;
    const wd = weekday(date);

    const ff = freeforms.find((r) => num(r.config.weekday, -1) === wd);
    if (ff && typeof ff.config.text === "string" && ff.config.text.trim()) {
      assignments.push({ date, recipeId: null, freeformText: ff.config.text.trim() });
      continue;
    }

    let pool = recipes;
    for (const r of maxTimes) {
      const days = Array.isArray(r.config.weekdays) ? (r.config.weekdays as unknown[]) : [];
      if (days.includes(wd)) {
        const max = num(r.config.max_total_min, Infinity);
        pool = pool.filter((p) => p.totalMin == null || p.totalMin <= max);
      }
    }
    for (const r of themes) {
      if (num(r.config.weekday, -1) !== wd) continue;
      const tag = String(r.config.tag ?? "").toLowerCase();
      const themed = pool.filter((p) => p.tags.includes(tag));
      if (themed.length) pool = themed;
      else warn(`No recipes tagged "${tag}" for the ${dayName(wd)} theme, so it was skipped.`);
    }

    const recentOk = (p: GenRecipe) =>
      !used.some((u) => u.recipeId === p.id && Math.abs(daysBetween(u.date, date)) < noRepeat);
    let candidates = noRepeat > 0 ? pool.filter(recentOk) : pool;
    if (!candidates.length && pool.length) {
      candidates = pool;
      warn("Not enough recipes to avoid repeats everywhere, so some meals repeat sooner.");
    }
    if (!candidates.length) {
      if (recipes.length) warn(`Nothing fit on ${date}, so it was left empty.`);
      assignments.push({ date, recipeId: null, freeformText: null });
      continue;
    }

    const wk = weekKey(date);
    const weights = candidates.map((p) => {
      let w = 1;
      if (p.favorite) w *= 2;
      for (const q of quotas) {
        const tag = String(q.config.tag ?? "").toLowerCase();
        if (!p.tags.includes(tag)) continue;
        const have = used.filter(
          (u) => weekKey(u.date) === wk && recipes.find((x) => x.id === u.recipeId)?.tags.includes(tag),
        ).length;
        if (have < num(q.config.per_week, 1)) w *= 3;
      }
      if (used.some((u) => u.recipeId === p.id && Math.abs(daysBetween(u.date, date)) < 28)) w *= 0.3;
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let x = rand() * total;
    let pick = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      x -= weights[i];
      if (x <= 0) {
        pick = candidates[i];
        break;
      }
    }
    used.push({ date, recipeId: pick.id });
    assignments.push({ date, recipeId: pick.id, freeformText: null });
  }
  return { assignments, warnings };
}

function dayName(wd: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][wd] ?? "?";
}
