/**
 * Pure roster-correction model. A correction (recorded by an approver in a
 * verdict thread) optionally replaces the day's crew and/or overrides who counts
 * for that day's bonus. `applyRosterCorrection` resolves the effective crew +
 * per-person counted flag against the parsed baseline. No DB/Next imports.
 */
export interface RosterCorrection {
  date: string;
  /** Authoritative crew for the day (replaces the parsed roster) when present. */
  roster?: string[];
  /** Per-person override of the day's bonus gate. */
  eligibility?: Record<string, "counted" | "not_counted">;
  note: string;
  by: string;
  source: string;
  recordedAt: string;
}

export function applyRosterCorrection(
  parsedRoster: string[],
  dayCounted: boolean,
  correction?: RosterCorrection,
): { roster: string[]; perPerson: { name: string; counted: boolean }[] } {
  const roster = correction?.roster ?? parsedRoster;
  const elig = correction?.eligibility;
  const perPerson = roster.map((name) => ({
    name,
    counted: elig?.[name] === "not_counted" ? false : elig?.[name] === "counted" ? true : dayCounted,
  }));
  return { roster, perPerson };
}
