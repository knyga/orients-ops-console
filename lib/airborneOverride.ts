/**
 * Pure airborne-minutes override model. An approver can correct the airborne
 * figure a flight day is judged against (e.g. a #field-qa "Звіт" reported no
 * quantified time, or the Stats-bot figure was wrong). The override REPLACES the
 * committed field-qa airborne minutes for its date and can surface a date that
 * had no committed figure at all. No DB/Next imports — unit-tested in isolation.
 * The DB read/write lives in lib/airborneOverrides.ts (mirrors the
 * rosterCorrection.ts / rosterCorrections.ts split).
 */
export interface AirborneOverride {
  date: string; // YYYY-MM-DD flight day
  minutes: number; // authoritative airborne minutes for the day
  note: string;
  by: string; // approver name
  source: string; // permalink or "manual"
  recordedAt: string; // ISO
}

/**
 * Overlay airborne-minutes overrides onto the committed airborne-by-date map.
 * The override wins (and adds dates absent from the base). Returns a NEW map;
 * the input is not mutated.
 */
export function overlayAirborne(
  airborneByDate: Map<string, number>,
  overrides: AirborneOverride[],
): Map<string, number> {
  const out = new Map(airborneByDate);
  for (const o of overrides) out.set(o.date, o.minutes);
  return out;
}
