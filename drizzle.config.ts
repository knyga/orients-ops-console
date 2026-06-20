/**
 * drizzle-kit config — generates + applies SQL migrations from lib/schema.ts.
 * Migrations use the DIRECT (non-pooled) connection; the pooled POSTGRES_URL is
 * for the serverless runtime. Loads .env / .env.local so `npm run db:*` works
 * locally without extra tooling.
 */
import { defineConfig } from "drizzle-kit";

for (const f of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    // file absent — rely on the ambient environment (e.g. Vercel)
  }
}

const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL;
if (!url) throw new Error("POSTGRES_URL_NON_POOLING (or POSTGRES_URL) must be set for migrations.");

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
