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

/**
 * Source precedence: a bulk crew-sheet import (`field-ops-sheet`) must NOT
 * overwrite an approver/manual correction (any other source). Approver decisions
 * are authoritative — so a re-import of the tracking sheet can never silently
 * regress a confirmed correction (e.g. the 2026-06-25 [Влад, Тарас] fix). A
 * fresh day, or one whose only correction is itself a sheet write, updates
 * freely; a non-sheet write is never blocked. Pure.
 */
export function sheetImportShouldSkip(existingSource: string | undefined, incomingSource: string): boolean {
  return incomingSource === "field-ops-sheet" && existingSource !== undefined && existingSource !== "field-ops-sheet";
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
