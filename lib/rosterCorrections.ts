/**
 * Durable roster-correction store — approver corrections to a day's crew +
 * per-person bonus eligibility, keyed by flight date. Backed by the
 * `roster_corrections` Postgres table; read by the verdict (display) and the
 * bonus calc. NOT server-only (CLIs import it, like lib/resolutions.ts).
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { sheetImportShouldSkip, type RosterCorrection } from "./rosterCorrection";

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
  // Source precedence: a bulk crew-sheet import never clobbers an approver/manual
  // correction (see sheetImportShouldSkip). Cheap guard — one keyed read.
  if (c.source === "field-ops-sheet") {
    const existing = await db
      .select({ source: schema.rosterCorrections.source })
      .from(schema.rosterCorrections)
      .where(eq(schema.rosterCorrections.date, c.date));
    if (existing.length > 0 && sheetImportShouldSkip(existing[0].source, c.source)) return;
  }

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
