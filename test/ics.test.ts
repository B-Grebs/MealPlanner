import { describe, expect, it } from "vitest";
import { buildIcs } from "../worker/lib/ics";

describe("buildIcs", () => {
  it("builds all-day events with escaped text", () => {
    const ics = buildIcs("Dinner", [{ uid: "a@x", date: "2026-12-31", summary: "Tacos, extra\; cheese" }], new Date("2026-12-01T00:00:00Z"));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261231");
    expect(ics).toContain("DTEND;VALUE=DATE:20270101");
    expect(ics).toContain(String.raw`SUMMARY:Tacos\, extra\; cheese`);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
