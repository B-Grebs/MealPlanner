const FRACTIONS: Array<[number, string]> = [
  [0.125, "⅛"], [0.25, "¼"], [0.333, "⅓"], [0.5, "½"], [0.667, "⅔"], [0.75, "¾"],
];

export function formatQty(qty: number | null | undefined): string {
  if (qty == null) return "";
  const whole = Math.floor(qty + 1e-9);
  const frac = qty - whole;
  if (frac < 0.02) return String(whole);
  for (const [v, s] of FRACTIONS) if (Math.abs(frac - v) < 0.02) return whole ? `${whole}${s}` : s;
  return String(Math.round(qty * 100) / 100);
}

export function formatAmount(qty: number | null, unit: string): string {
  const q = formatQty(qty);
  if (!q) return unit;
  if (!unit) return q;
  const plural = qty != null && qty > 1 && ["cup", "can", "jar", "clove", "bunch", "head", "packet", "package", "bag", "box", "bottle", "slice", "stick", "sprig", "stalk", "container", "carton"].includes(unit);
  return `${q} ${unit}${plural ? "s" : ""}`;
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export function monthDates(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function shortDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function minutes(m: number | null): string {
  if (m == null) return "";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
