import { describe, expect, it } from "vitest";
import { aggregate, type AggLine } from "../worker/lib/aggregate";
import { formatQty } from "../worker/lib/units";

const line = (o: Partial<AggLine>): AggLine => ({
  entryId: 1, ingredientId: 1, ingredientName: "onion", aisle: "Produce", isStaple: false,
  qty: 1, unit: "", scale: 1, ...o,
});

describe("aggregate", () => {
  it("sums counts across recipes", () => {
    const items = aggregate([line({ qty: 2 }), line({ entryId: 2, qty: 1 })], false);
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(3);
    expect(items[0].sourceEntryIds).toEqual([1, 2]);
  });

  it("converts volume units and picks a readable one", () => {
    const items = aggregate(
      [line({ ingredientId: 2, ingredientName: "milk", qty: 1, unit: "cup" }), line({ ingredientId: 2, ingredientName: "milk", qty: 4, unit: "tbsp" })],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0].unit).toBe("cup");
    expect(items[0].qty).toBe(1.25);
  });

  it("keeps different families on separate lines", () => {
    const items = aggregate(
      [line({ ingredientId: 3, ingredientName: "tomatoes", qty: 2, unit: "cup" }), line({ ingredientId: 3, ingredientName: "tomatoes", qty: 1, unit: "can" })],
      false,
    );
    expect(items.map((i) => `${i.qty} ${i.unit}`).sort()).toEqual(["1 can", "2 cup"]);
  });

  it("scales by servings and converts oz to lb", () => {
    const items = aggregate([line({ ingredientId: 4, ingredientName: "beef", qty: 12, unit: "oz", scale: 2 })], false);
    expect(items[0]).toMatchObject({ qty: 1.5, unit: "lb" });
  });

  it("drops staples unless asked", () => {
    const l = line({ ingredientId: 5, ingredientName: "salt", isStaple: true, qty: null });
    expect(aggregate([l], false)).toHaveLength(0);
    expect(aggregate([l], true)[0].qty).toBeNull();
  });

  it("keeps metric in metric", () => {
    const items = aggregate([line({ ingredientId: 6, ingredientName: "flour", qty: 600, unit: "g" }), line({ ingredientId: 6, ingredientName: "flour", qty: 0.5, unit: "kg" })], false);
    expect(items[0]).toMatchObject({ qty: 1.1, unit: "kg" });
  });
});

describe("formatQty", () => {
  it("uses fractions", () => {
    expect(formatQty(1.5)).toBe("1½");
    expect(formatQty(0.25)).toBe("¼");
    expect(formatQty(3)).toBe("3");
    expect(formatQty(null)).toBe("");
  });
});
