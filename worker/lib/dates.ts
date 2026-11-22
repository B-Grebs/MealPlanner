// Plain-date helpers. Plan dates are local calendar dates "YYYY-MM-DD" with no time zone.

export function isMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function weekday(date: string): number {
  return utc(date).getUTCDay(); // 0 = Sunday
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthDates(month: string): string[] {
  const n = daysInMonth(month);
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return fmt(d).slice(0, 7);
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return fmt(d).slice(0, 7);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b).getTime() - utc(a).getTime()) / 86_400_000);
}

/** Which occurrence of its weekday a date is in its month (1-based): the 2nd Tuesday → 2. */
export function nthWeekday(date: string): number {
  return Math.floor((Number(date.slice(8, 10)) - 1) / 7) + 1;
}

/**
 * Map a date to the same "nth weekday" in another month (ARCHITECTURE §5).
 * Returns null when the target month has no such day (e.g. a 5th Monday).
 */
export function mapNthWeekday(date: string, targetMonth: string): string | null {
  const wd = weekday(date);
  const nth = nthWeekday(date);
  const first = `${targetMonth}-01`;
  const offset = (wd - weekday(first) + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  if (day > daysInMonth(targetMonth)) return null;
  return `${targetMonth}-${String(day).padStart(2, "0")}`;
}

/** Today's local date in a time zone, e.g. "America/Chicago". */
export function todayIn(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Monday-based week key, used for per-week quotas. */
export function weekKey(date: string): string {
  const wd = weekday(date);
  return addDays(date, -((wd + 6) % 7));
}
