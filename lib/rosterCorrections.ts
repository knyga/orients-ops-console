/**
 * Durable roster-correction store — approver corrections to a day's crew +
 * per-person bonus eligibility, keyed by flight date. Backed by the
 * `roster_corrections` Postgres table; read by the verdict (display) and the
 * bonus calc. NOT server-only (CLIs import it, like lib/resolutions.ts).
 */
import { db, schema } from "./db";
import type { RosterCorrection } from "./rosterCorrection";

function toCorrection(r: typeof schema.rosterCorrections.$inferSelect): RosterCorrection {
  return {
    date: r.date,
    note: r.note,
    by: r.by,
    source: r.source,
    recordedAt: r.recordedAt,
    ...(r.roster != null ? { roster: r.roster as string[] } : {}),
    ...(r.eligibility != null ? { eligibility: r.eligibility as Record<string, "counted" | "not_counted"> } : {}),
  };
}

export async function readRosterCorrections(): Promise<RosterCorrection[]> {
  const rows = await db.select().from(schema.rosterCorrections);
  return rows.map(toCorrection);
}

export async function upsertRosterCorrection(c: RosterCorrection): Promise<void> {
  const values = {
    date: c.date,
    roster: c.roster ?? null,
    eligibility: c.eligibility ?? null,
    note: c.note,
    by: c.by,
    source: c.source,
    recordedAt: c.recordedAt,
  };
  await db
    .insert(schema.rosterCorrections)
    .values(values)
    .onConflictDoUpdate({ target: schema.rosterCorrections.date, set: values });
}
