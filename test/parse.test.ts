import { describe, expect, it } from "vitest";
import { parseIngredientLine, parseRecipeText } from "../worker/lib/parse";

describe("parseIngredientLine", () => {
  const cases: Array<[string, number | null, string, string, string | null]> = [
    ["- 1 lb ground beef", 1, "lb", "ground beef", null],
    ["1 1/2 cups shredded cheddar, divided", 1.5, "cup", "shredded cheddar", "divided"],
    ["½ tsp salt", 0.5, "tsp", "salt", null],
    ["1½ tbsp olive oil", 1.5, "tbsp", "olive oil", null],
    ["2-3 cloves garlic, minced", 3, "clove", "garlic", "minced"],
    ["1 (15 oz) can black beans, drained", 1, "can", "black beans", "15 oz; drained"],
    ["8 small tortillas", 8, "", "small tortillas", null],
    ["salt, to taste", null, "", "salt", "to taste"],
    ["a pinch of nutmeg", 1, "pinch", "nutmeg", null],
    ["an onion", 1, "", "onion", null],
    ["2 Tbsp. butter (softened)", 2, "tbsp", "butter", "softened"],
    ["1/3 cup milk", 1 / 3, "cup", "milk", null],
    ["16 fl oz chicken broth", 16, "fl oz", "chicken broth", null],
    ["3 eggs", 3, "", "eggs", null],
  ];
  for (const [line, qty, unit, name, note] of cases) {
    it(line, () => {
      const r = parseIngredientLine(line)!;
      if (qty == null) expect(r.qty).toBeNull();
      else expect(r.qty).toBeCloseTo(qty, 5);
      expect(r.unit).toBe(unit);
      expect(r.name).toBe(name);
      expect(r.note).toBe(note);
    });
  }
});

describe("parseRecipeText", () => {
  it("reads several recipes with meta, ingredients and steps", () => {
    const text = `# Chicken Tacos
servings: 4
prep: 10
cook: 20 min
tags: Tacos, quick, kid-fave
source: https://example.com/tacos
note: thaw the chicken the night before

## Ingredients
- 1 lb chicken thighs, diced
- 1 packet taco seasoning
- 8 small tortillas

## Steps
1. Brown the chicken.
2. Add seasoning.

---

# Spaghetti
serves: 6
time: 1h 15m
- 1 lb spaghetti
- 1 jar marinara
Boil water.`;
    const { recipes, warnings } = parseRecipeText(text);
    expect(recipes).toHaveLength(2);
    const [a, b] = recipes;
    expect(a.title).toBe("Chicken Tacos");
    expect(a.servings).toBe(4);
    expect(a.prep_min).toBe(10);
    expect(a.cook_min).toBe(20);
    expect(a.tags).toEqual(["tacos", "quick", "kid-fave"]);
    expect(a.prep_note).toBe("thaw the chicken the night before");
    expect(a.ingredients.map((i) => i.name)).toEqual(["chicken thighs", "taco seasoning", "small tortillas"]);
    expect(a.instructions_md).toBe("1. Brown the chicken.\n2. Add seasoning.");
    expect(b.servings).toBe(6);
    expect(b.cook_min).toBe(75);
    expect(b.ingredients).toHaveLength(2);
    expect(b.instructions_md).toBe("Boil water.");
    expect(warnings).toEqual([]);
  });

  it("warns on an empty paste", () => {
    expect(parseRecipeText("   ").warnings[0]).toMatch(/No recipes/);
  });
});
