import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_TZ: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Local dev only (.dev.vars). Never set in production. */
  DEV_AUTH_EMAIL?: string;
}

export type Principal =
  | { kind: "user"; userId: number; email: string; name: string | null }
  | { kind: "client"; clientDbId: number; name: string; scopes: string[] };

export type DB = DrizzleD1Database<typeof schema>;

export interface AppEnv {
  Bindings: Env;
  Variables: { principal: Principal; db: DB };
}
