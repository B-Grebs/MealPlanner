// Parsers for bulk recipe import (ARCHITECTURE §6.4).
import { isUnitWord, normalizeUnit } from "./units";

export interface ParsedIngredient {
  qty: number | null;
  unit: string;
  name: string;
  note: string | null;
  raw: string;
}

export interface ParsedRecipe {
  title: string;
  description: string | null;
  servings: number;
  prep_min: number | null;
  cook_min: number | null;
  tags: string[];
  source_url: string | null;
  prep_note: string | null;
  favorite: boolean;
  instructions_md: string | null;
  ingredients: ParsedIngredient[];
}

export interface ParseResult {
  recipes: ParsedRecipe[];
  warnings: string[];
}

const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?(?:\s*[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])?|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|to)\s*(${NUM}))?\s*`, "i");

function parseNumber(s: string): number {
  s = s.trim();
  let total = 0;
  for (const [ch, v] of Object.entries(UNICODE_FRACTIONS)) {
    if (s.includes(ch)) {
      total += v;
      s = s.replace(ch, "").trim();
    }
  }
  if (!s) return total;
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return total + Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return total + Number(frac[1]) / Number(frac[2]);
  return total + Number(s);
}

/** Parse "1 1/2 cups shredded cheddar, divided" into qty/unit/name/note. */
export function parseIngredientLine(line: string): ParsedIngredient | null {
  const raw = line.trim();
  let s = raw.replace(/^[-*•·]\s*/, "").replace(/^\d+[.)]\s+(?=\D)/, "").trim();
  if (!s) return null;

  let qty: number | null = null;
  const m = s.match(QTY_RE);
  if (m) {
    const a = parseNumber(m[1]);
    const b = m[2] ? parseNumber(m[2]) : null;
    qty = b != null && b > a ? b : a; // ranges take the high end
    s = s.slice(m[0].length);
  }

  // Parenthetical size right after the quantity: "1 (15 oz) can black beans"
  let sizeNote: string | null = null;
  const paren = s.match(/^\(([^)]*)\)\s*/);
  if (paren) {
    sizeNote = paren[1].trim();
    s = s.slice(paren[0].length);
  }

  let unit = "";
  if (qty != null || /^(a|an)\s/i.test(s)) {
    if (qty == null) {
      // "a pinch of salt"
      const art = s.match(/^(a|an)\s+/i)!;
      const rest = s.slice(art[0].length);
      qty = 1; // "a pinch of salt", "an onion"
      s = rest;
    }
    const two = s.match(/^((?:fl\.?|fluid)\s+(?:oz\.?|ounces?))\b\.?\s*/i);
    const one = s.match(/^([a-zA-Z#]+)\.?(?=\s|$)\s*/);
    if (two) {
      unit = normalizeUnit(two[1].replace(/\s+/, " ").replace("fluid", "fl").replace("fl.", "fl"));
      s = s.slice(two[0].length);
    } else if (one && isUnitWord(one[1])) {
      unit = normalizeUnit(one[1]);
      s = s.slice(one[0].length);
    }
    s = s.replace(/^of\s+/i, "");
  }

  // Note: trailing parenthetical or text after the first comma.
  let note: string | null = null;
  const trailingParen = s.match(/\s*\(([^)]*)\)\s*$/);
  if (trailingParen) {
    note = trailingParen[1].trim();
    s = s.slice(0, trailingParen.index).trim();
  }
  const comma = s.indexOf(",");
  if (comma >= 0) {
    const after = s.slice(comma + 1).trim();
    note = [after, note].filter(Boolean).join("; ") || null;
    s = s.slice(0, comma).trim();
  }
  if (sizeNote) note = [sizeNote, note].filter(Boolean).join("; ");

  const name = s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!name) return null;
  return { qty, unit, name, note: note || null, raw };
}

const META_KEYS: Record<string, keyof ParsedRecipe | "time"> = {
  servings: "servings", serves: "servings", yield: "servings", makes: "servings",
  prep: "prep_min", "prep time": "prep_min",
  cook: "cook_min", "cook time": "cook_min",
  time: "time", "total time": "time",
  tags: "tags", tag: "tags",
  source: "source_url", url: "source_url",
  note: "prep_note", "prep note": "prep_note",
  description: "description",
  favorite: "favorite", favourite: "favorite",
};

function minutes(v: string): number | null {
  const h = v.match(/(\d+(?:\.\d+)?)\s*h/i);
  const m = v.match(/(\d+)\s*m/i);
  if (h || m) return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Parse the plain-text bulk format: recipes separated by "---". */
export function parseRecipeText(text: string): ParseResult {
  const warnings: string[] = [];
  const recipes: ParsedRecipe[] = [];
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/^\s*-{3,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  blocks.forEach((block, bi) => {
    const lines = block.split("\n");
    const r: ParsedRecipe = {
      title: "",
      description: null,
      servings: 4,
      prep_min: null,
      cook_min: null,
      tags: [],
      source_url: null,
      prep_note: null,
      favorite: false,
      instructions_md: null,
      ingredients: [],
    };
    let section: "meta" | "ingredients" | "steps" = "meta";
    let explicitIngredients = false;
    const steps: string[] = [];
    const descLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const t = line.trim();
      if (!r.title) {
        if (!t) continue;
        r.title = t.replace(/^#+\s*/, "").trim();
        continue;
      }
      const heading = t.match(/^#{1,6}\s*(.+)$/) ?? t.match(/^([A-Za-z ]+):\s*$/);
      if (heading) {
        const h = heading[1].toLowerCase();
        if (/ingredient/.test(h)) { section = "ingredients"; explicitIngredients = true; continue; }
        if (/step|instruction|method|direction|prep/.test(h)) { section = "steps"; continue; }
      }
      if (section === "meta") {
        const kv = t.match(/^([A-Za-z ]+):\s*(.+)$/);
        const key = kv ? META_KEYS[kv[1].trim().toLowerCase()] : undefined;
        if (kv && key) {
          const v = kv[2].trim();
          if (key === "servings") r.servings = parseInt(v, 10) || 4;
          else if (key === "prep_min") r.prep_min = minutes(v);
          else if (key === "cook_min") r.cook_min = minutes(v);
          else if (key === "time") r.cook_min ??= minutes(v);
          else if (key === "tags") r.tags = v.split(/[,;]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
          else if (key === "source_url") r.source_url = v;
          else if (key === "prep_note") r.prep_note = v;
          else if (key === "description") r.description = v;
          else if (key === "favorite") r.favorite = /^(y|yes|true|1)$/i.test(v);
          continue;
        }
        if (/^[-*•]\s/.test(t)) { section = "ingredients"; }
        else { if (t) descLines.push(t); continue; }
      }
      if (section === "ingredients") {
        if (!t) continue;
        // Without an "Ingredients" heading, the first non-bullet line starts the steps.
        if (!explicitIngredients && !/^[-*•]\s/.test(t)) {
          section = "steps";
          steps.push(line);
          continue;
        }
        const ing = parseIngredientLine(t);
        if (ing) r.ingredients.push(ing);
        else warnings.push(`Recipe ${bi + 1} ("${r.title}"): couldn't read ingredient line "${t}"`);
        continue;
      }
      steps.push(line);
    }

    if (!r.title) return;
    if (descLines.length && !r.description) r.description = descLines.join(" ");
    const instr = steps.join("\n").trim();
    r.instructions_md = instr || null;
    if (!r.ingredients.length) warnings.push(`"${r.title}" has no ingredients`);
    for (const ing of r.ingredients) {
      if (ing.qty == null && !/to taste|optional|as needed/i.test(ing.raw)) {
        warnings.push(`"${r.title}": no quantity for "${ing.name}"`);
      }
    }
    recipes.push(r);
  });

  if (!recipes.length) warnings.push("No recipes found. Start each recipe with a title line.");
  return { recipes, warnings };
}
