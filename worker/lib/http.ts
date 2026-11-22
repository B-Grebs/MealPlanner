// Small request-validation helpers; keeps the API free of a schema library.

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

export function bad(message: string): never {
  throw new HttpError(400, message);
}

export function notFound(what = "Not found"): never {
  throw new HttpError(404, what);
}

type Obj = Record<string, unknown>;

export function obj(v: unknown, what = "body"): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${what} must be an object`);
  return v as Obj;
}

export function str(o: Obj, k: string, opts: { max?: number } = {}): string {
  const v = o[k];
  if (typeof v !== "string" || !v.trim()) bad(`${k} is required`);
  return clip(v.trim(), opts.max ?? 500);
}

export function optStr(o: Obj, k: string, opts: { max?: number } = {}): string | null | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") bad(`${k} must be text`);
  const t = v.trim();
  return t ? clip(t, opts.max ?? 500) : null;
}

export function optNum(o: Obj, k: string, opts: { min?: number; max?: number; int?: boolean } = {}) {
  const v = o[k];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) bad(`${k} must be a number`);
  if (opts.min != null && n < opts.min) bad(`${k} must be at least ${opts.min}`);
  if (opts.max != null && n > opts.max) bad(`${k} must be at most ${opts.max}`);
  return opts.int ? Math.round(n) : n;
}

export function optBool(o: Obj, k: string): boolean | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  bad(`${k} must be true or false`);
}

export function idParam(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) notFound();
  return n;
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** JSON.stringify capped to a byte budget, for raw payload storage. */
export function rawJson(v: unknown, max = 8192): string | null {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  return s.length > max ? JSON.stringify({ truncated: true, head: s.slice(0, max - 64) }) : s;
}

export function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
