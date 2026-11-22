import { describe, expect, it } from "vitest";
import { generatePlan, type GenRecipe } from "../worker/lib/generate";
import { mapNthWeekday, monthDates, weekday } from "../worker/lib/dates";

const recipes: GenRecipe[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  title: `R${i + 1}`,
  tags: i < 3 ? ["tacos"] : i < 5 ? ["fish"] : [],
  totalMin: i % 2 ? 30 : 90,
  favorite: i === 7,
}));

describe("generatePlan", () => {
  const dates = monthDates("2026-12");

  it("is reproducible with the same seed", () => {
    const a = generatePlan({ dates, existing: [], history: [], recipes, rules: [], seed: 42 });
    const b = generatePlan({ dates, existing: [], history: [], recipes, rules: [], seed: 42 });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.assignments).toHaveLength(31);
  });

  it("keeps locked days and applies rules", () => {
    const res = generatePlan({
      dates,
      existing: [{ date: "2026-12-01", recipeId: 9, freeformText: null, locked: true }],
      history: [],
      recipes,
      rules: [
        { kind: "no_repeat_within", config: { days: 14 } },
        { kind: "weekday_theme", config: { weekday: 2, tag: "tacos" } },
        { kind: "fixed_freeform", config: { weekday: 5, text: "Pizza night" } },
        { kind: "weekday_max_time", config: { weekdays: [1, 3, 4], max_total_min: 45 } },
      ],
      seed: 7,
    });
    expect(res.assignments.find((a) => a.date === "2026-12-01")).toBeUndefined();
    for (const a of res.assignments) {
      const wd = weekday(a.date);
      if (wd === 5) expect(a.freeformText).toBe("Pizza night");
      if (wd === 2) expect([1, 2, 3]).toContain(a.recipeId);
      if ([1, 3, 4].includes(wd)) expect(recipes.find((r) => r.id === a.recipeId)!.totalMin).toBeLessThanOrEqual(45);
    }
    // No recipe twice within 14 days (taco days have only 3 options, so they may relax).
    const picks = res.assignments.filter((a) => a.recipeId && weekday(a.date) !== 2);
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        if (picks[i].recipeId === picks[j].recipeId) {
          const gap = (Date.parse(picks[j].date) - Date.parse(picks[i].date)) / 86400000;
          expect(gap).toBeGreaterThanOrEqual(14);
        }
      }
    }
  });

  it("warns when there are no recipes", () => {
    const res = generatePlan({ dates, existing: [], history: [], recipes: [], rules: [], seed: 1 });
    expect(res.warnings[0]).toMatch(/no recipes/i);
  });
});

describe("mapNthWeekday", () => {
  it("maps the 2nd Tuesday to the 2nd Tuesday", () => {
    expect(mapNthWeekday("2026-10-13", "2026-11")).toBe("2026-11-10");
  });
  it("drops a 5th weekday that doesn't exist", () => {
    expect(mapNthWeekday("2026-10-29", "2026-11")).toBeNull(); // 5th Thursday of Oct; Nov has four
  });
});
