// Shopping list aggregation (ARCHITECTURE §6.1). Pure: no database access.
import { aggregationKey, fromBase, normalizeUnit, roundQty, toBase, unitInfo } from "./units";

export interface AggLine {
  entryId: number;
  ingredientId: number;
  ingredientName: string;
  aisle: string | null;
  isStaple: boolean;
  qty: number | null;
  unit: string;
  /** recipe-level scale, servings_override / servings */
  scale: number;
}

export interface AggItem {
  ingredientId: number;
  text: string;
  qty: number | null;
  unit: string;
  aisle: string | null;
  sourceEntryIds: number[];
  /** Stable key for keeping checked state across regenerations. */
  key: string;
}

export function itemKey(ingredientId: number | null, unit: string): string {
  return `${ingredientId ?? "x"}|${aggregationKey(unit)}`;
}

export function aggregate(lines: AggLine[], includeStaples: boolean): AggItem[] {
  interface Bucket {
    ingredientId: number;
    name: string;
    aisle: string | null;
    family: ReturnType<typeof unitInfo>["family"];
    otherUnit: string;
    base: number;
    hasQty: boolean;
    allMetric: boolean;
    entries: Set<number>;
  }
  const buckets = new Map<string, Bucket>();
  for (const l of lines) {
    if (l.isStaple && !includeStaples) continue;
    const unit = normalizeUnit(l.unit);
    const info = unitInfo(unit);
    const key = itemKey(l.ingredientId, unit);
    let b = buckets.get(key);
    if (!b) {
      b = {
        ingredientId: l.ingredientId,
        name: l.ingredientName,
        aisle: l.aisle,
        family: info.family,
        otherUnit: unit,
        base: 0,
        hasQty: false,
        allMetric: true,
        entries: new Set(),
      };
      buckets.set(key, b);
    }
    b.entries.add(l.entryId);
    if (l.qty != null && Number.isFinite(l.qty)) {
      b.base += toBase(l.qty * l.scale, unit);
      b.hasQty = true;
      if (!info.metric) b.allMetric = false;
    }
  }

  const items: AggItem[] = [];
  for (const [key, b] of buckets) {
    let qty: number | null = null;
    let unit = b.family === "other" ? b.otherUnit : "";
    if (b.hasQty) {
      const d = fromBase(b.base, b.family, b.family !== "count" && b.family !== "other" && b.allMetric, b.otherUnit);
      unit = d.unit;
      qty = roundQty(d.qty, d.unit);
    }
    items.push({
      ingredientId: b.ingredientId,
      text: b.name,
      qty,
      unit,
      aisle: b.aisle,
      sourceEntryIds: [...b.entries].sort((a, c) => a - c),
      key,
    });
  }
  items.sort((a, c) => a.text.localeCompare(c.text) || a.unit.localeCompare(c.unit));
  return items;
}
