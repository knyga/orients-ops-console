/**
 * Committed-artifact store for sprint completion, on top of the shared `reports`
 * table (feature = "sprint", period = the sprint slug). One row per sprint holds
 * the frozen COMMITTED baseline and, once the Monday report job runs, the COMPLETED
 * result — "freeze then enrich".
 *
 * Deliberately NOT `server-only`: no secrets, imported by both the API routes and
 * the Node CLI. Mirrors lib/reports.ts, but keyed by an arbitrary sprint slug
 * rather than a date period key.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { PublishedPlan } from "./sprintPublish";
import type { CompletionResult, SprintSnapshot } from "./sprintReport";

const FEATURE = "sprint";

/** The JSON shape stored per sprint (the web's render source). */
export interface SprintRecord {
  committed: SprintSnapshot;
  completed?: {
    computedAt: string;
    /** Legacy rows (pre-v2) may hold the old result shape (`byAssignee`, no `assignees`). */
    result: CompletionResult;
  };
  /**
   * Slack publications frozen at their first publish attempt, per (kind, channel).
   * A retry replays these exact texts so the positional thread-reply dedup keys
   * keep describing the same content (see lib/sprintPublish.ts). Absent until the
   * first `--publish` run.
   */
  published?: PublishedPlan[];
}

/** Read one sprint's record by slug, or null when absent. */
export async function readSprint(slug: string): Promise<SprintRecord | null> {
  const rows = await db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.feature, FEATURE), eq(schema.reports.period, slug)))
    .limit(1);
  return rows.length ? (rows[0].json as SprintRecord) : null;
}

/** Upsert one sprint's record by slug. */
export async function writeSprint(slug: string, record: SprintRecord): Promise<void> {
  const values = {
    feature: FEATURE,
    period: slug,
    json: record,
    csv: null,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(schema.reports)
    .values(values)
    .onConflictDoUpdate({ target: [schema.reports.feature, schema.reports.period], set: values });
}

/** Sprint slugs with a stored record, newest first. */
export async function listSprintSlugs(): Promise<string[]> {
  const rows = await db
    .select({ period: schema.reports.period })
    .from(schema.reports)
    .where(eq(schema.reports.feature, FEATURE))
    .orderBy(desc(schema.reports.updatedAt));
  return rows.map((r) => r.period);
}
