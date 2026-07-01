/**
 * Durable airborne-minutes overrides store — the agent's memory of approver
 * corrections to a flight day's airborne figure. Consulted by the verdict
 * (lib/computeVerdicts) so an override replaces the committed field-qa minutes.
 * Backed by the `airborne_overrides` Postgres table (keyed by flight date),
 * shared by CLIs, the events route, and web.
 *
 * NOT server-only: the CLIs import it (like lib/resolutions.ts). The overlay
 * logic is pure (lib/airborneOverride.ts); only read/write hit the DB.
 */
import { db, schema } from "./db";
import type { AirborneOverride } from "./airborneOverride";

export type { AirborneOverride } from "./airborneOverride";
export { overlayAirborne } from "./airborneOverride";

function toOverride(r: typeof schema.airborneOverrides.$inferSelect): AirborneOverride {
  return {
    date: r.date,
    minutes: r.minutes,
    note: r.note,
    by: r.by,
    source: r.source,
    recordedAt: r.recordedAt,
  };
}

/** All airborne overrides (empty when none). */
export async function readAirborneOverrides(): Promise<AirborneOverride[]> {
  const rows = await db.select().from(schema.airborneOverrides);
  return rows.map(toOverride);
}

/** Insert or replace the airborne override for its date. */
export async function upsertAirborneOverride(override: AirborneOverride): Promise<void> {
  const values = {
    date: override.date,
    minutes: override.minutes,
    note: override.note,
    by: override.by,
    source: override.source,
    recordedAt: override.recordedAt,
  };
  await db
    .insert(schema.airborneOverrides)
    .values(values)
    .onConflictDoUpdate({ target: schema.airborneOverrides.date, set: values });
}
