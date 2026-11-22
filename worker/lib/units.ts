// Minimal unit normalization for shopping aggregation (ARCHITECTURE §6.1).

export type Family = "volume" | "weight" | "count" | "other";

interface UnitDef {
  canonical: string;
  family: Family;
  /** Size in the family's base unit (ml for volume, g for weight, 1 for count). */
  factor: number;
  metric?: boolean;
}

const DEFS: Record<string, UnitDef> = {
  tsp: { canonical: "tsp", family: "volume", factor: 4.92892 },
  tbsp: { canonical: "tbsp", family: "volume", factor: 14.7868 },
  "fl oz": { canonical: "fl oz", family: "volume", factor: 29.5735 },
  cup: { canonical: "cup", family: "volume", factor: 236.588 },
  pint: { canonical: "pint", family: "volume", factor: 473.176 },
  quart: { canonical: "quart", family: "volume", factor: 946.353 },
  gallon: { canonical: "gallon", family: "volume", factor: 3785.41 },
  ml: { canonical: "ml", family: "volume", factor: 1, metric: true },
  l: { canonical: "l", family: "volume", factor: 1000, metric: true },
  oz: { canonical: "oz", family: "weight", factor: 28.3495 },
  lb: { canonical: "lb", family: "weight", factor: 453.592 },
  g: { canonical: "g", family: "weight", factor: 1, metric: true },
  kg: { canonical: "kg", family: "weight", factor: 1000, metric: true },
  "": { canonical: "", family: "count", factor: 1 },
};

const ALIASES: Record<string, string> = {
  t: "tsp", tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  c: "cup", cup: "cup", cups: "cup",
  "fl oz": "fl oz", "fl. oz": "fl oz", floz: "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz",
  pt: "pint", pint: "pint", pints: "pint",
  qt: "quart", quart: "quart", quarts: "quart",
  gal: "gallon", gallon: "gallon", gallons: "gallon",
  ml: "ml", milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml",
  l: "l", liter: "l", liters: "l", litre: "l", litres: "l",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", "#": "lb",
  g: "g", gram: "g", grams: "g", gr: "g",
  kg: "kg", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  "": "", each: "", ea: "", whole: "", count: "", ct: "", pc: "", pcs: "", piece: "", pieces: "",
};

/** Words that are units but not convertible; normalized to singular. */
const OTHER_UNITS: Record<string, string> = {
  can: "can", cans: "can",
  jar: "jar", jars: "jar",
  clove: "clove", cloves: "clove",
  bunch: "bunch", bunches: "bunch",
  head: "head", heads: "head",
  packet: "packet", packets: "packet", pkt: "packet",
  package: "package", packages: "package", pkg: "package",
  bag: "bag", bags: "bag",
  box: "box", boxes: "box",
  bottle: "bottle", bottles: "bottle",
  slice: "slice", slices: "slice",
  stick: "stick", sticks: "stick",
  sprig: "sprig", sprigs: "sprig",
  stalk: "stalk", stalks: "stalk",
  pinch: "pinch", pinches: "pinch",
  dash: "dash", dashes: "dash",
  handful: "handful", handfuls: "handful",
  container: "container", containers: "container",
  carton: "carton", cartons: "carton",
  loaf: "loaf", loaves: "loaf",
  dozen: "dozen",
};

/** Normalize a unit string. Unknown units are kept, lowercased and trimmed. */
export function normalizeUnit(raw: string | null | undefined): string {
  const u = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (u in ALIASES) return ALIASES[u];
  if (u in OTHER_UNITS) return OTHER_UNITS[u];
  return u;
}

/** True when `word` is something the ingredient parser should treat as a unit. */
export function isUnitWord(word: string): boolean {
  const u = word.trim().toLowerCase().replace(/\.$/, "");
  if (u === "") return false;
  return u in ALIASES || u in OTHER_UNITS;
}

export function unitInfo(unit: string): { family: Family; factor: number; metric: boolean } {
  const n = normalizeUnit(unit);
  const def = DEFS[n];
  if (def) return { family: def.family, factor: def.factor, metric: !!def.metric };
  return { family: "other", factor: 1, metric: false };
}

/** Key used to group lines of the same ingredient that can be summed together. */
export function aggregationKey(unit: string): string {
  const n = normalizeUnit(unit);
  const { family } = unitInfo(n);
  return family === "other" ? `other:${n}` : family;
}

/** Convert a quantity to its family's base unit. */
export function toBase(qty: number, unit: string): number {
  return qty * unitInfo(unit).factor;
}

/**
 * Pick a display unit for a summed base quantity.
 * `metric` is true when every contributing line was metric.
 */
export function fromBase(
  base: number,
  family: Family,
  metric: boolean,
  otherUnit = "",
): { qty: number; unit: string } {
  if (family === "volume") {
    if (metric) return base >= 1000 ? { qty: base / 1000, unit: "l" } : { qty: base, unit: "ml" };
    const cup = DEFS.cup.factor;
    const tbsp = DEFS.tbsp.factor;
    if (base >= cup * 0.25 - 0.01) return { qty: base / cup, unit: "cup" };
    if (base >= tbsp - 0.01) return { qty: base / tbsp, unit: "tbsp" };
    return { qty: base / DEFS.tsp.factor, unit: "tsp" };
  }
  if (family === "weight") {
    if (metric) return base >= 1000 ? { qty: base / 1000, unit: "kg" } : { qty: base, unit: "g" };
    const lb = DEFS.lb.factor;
    if (base >= lb - 0.5) return { qty: base / lb, unit: "lb" };
    return { qty: base / DEFS.oz.factor, unit: "oz" };
  }
  if (family === "count") return { qty: base, unit: "" };
  return { qty: base, unit: otherUnit };
}

/** Round to something a person would write on a list. */
export function roundQty(qty: number, unit: string): number {
  const n = normalizeUnit(unit);
  if (n === "cup" || n === "tsp" || n === "tbsp" || n === "lb") {
    return Math.round(qty * 4) / 4 || 0.25; // quarters, never 0
  }
  if (n === "g" || n === "ml") return Math.ceil(qty);
  if (n === "oz") return Math.round(qty * 2) / 2 || 0.5;
  if (unitInfo(n).family === "count" || unitInfo(n).family === "other") {
    // Count-like things are bought whole, but keep halves for e.g. "0.5 bunch".
    return Math.round(qty * 2) / 2 || 0.5;
  }
  return Math.round(qty * 100) / 100;
}

const FRACTIONS: Array<[number, string]> = [
  [0.25, "¼"], [0.333, "⅓"], [0.5, "½"], [0.667, "⅔"], [0.75, "¾"],
];

/** "1.5" → "1½", "0.25" → "¼", "3" → "3". */
export function formatQty(qty: number | null | undefined): string {
  if (qty == null) return "";
  const whole = Math.floor(qty + 1e-9);
  const frac = qty - whole;
  if (frac < 0.02) return String(whole);
  for (const [v, s] of FRACTIONS) {
    if (Math.abs(frac - v) < 0.02) return whole ? `${whole}${s}` : s;
  }
  return String(Math.round(qty * 100) / 100);
}
