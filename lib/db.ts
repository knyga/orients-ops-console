/**
 * Drizzle client over Vercel/Neon Postgres — the single source of truth for the
 * agent's durable state, shared by the web (API routes), the Slack events route,
 * the cron jobs, and the local CLIs. All connect via POSTGRES_URL.
 *
 * NOT server-only: the CLIs import it too (like lib/reports.ts). It holds a DB
 * connection, no secret literal; `@vercel/postgres` reads POSTGRES_URL from the
 * environment. The browser bundle never imports this (only API routes do).
 */
import { sql } from "@vercel/postgres";
import { drizzle } from "drizzle-orm/vercel-postgres";
import * as schema from "./schema";

export const db = drizzle(sql, { schema });
export { schema };
