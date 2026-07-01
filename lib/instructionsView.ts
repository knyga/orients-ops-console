/**
 * Pure shaping for the Instructions web/CLI view: merge the three applied-
 * correction sources (roster_corrections, resolutions, airborne_overrides) into
 * one date-sorted list, windowed to a period. No DB/Next imports — unit-tested.
 */
import type { AirborneOverride } from "./airborneOverride";
import type { Resolution } from "./resolutions";
import type { RosterCorrection } from "./rosterCorrection";

export interface CorrectionRow {
  date: string;
  axis: "crew" | "eligibility" | "day" | "dataset" | "video" | "airborne";
  summary: string;
  by: string;
  source: string;
  recordedAt: string;
}

const inWindow = (date: string, start: string, end: string): boolean => date >= start && date <= end;

export function mergeCorrections(
  rosters: RosterCorrection[],
  resolutions: Resolution[],
  airbornes: AirborneOverride[],
  start: string,
  end: string,
): CorrectionRow[] {
  const rows: CorrectionRow[] = [];

  for (const r of rosters) {
    if (!inWindow(r.date, start, end)) continue;
    const hasCrew = Array.isArray(r.roster) && r.roster.length > 0;
    rows.push({
      date: r.date,
      axis: hasCrew ? "crew" : "eligibility",
      summary: hasCrew ? `склад: ${r.roster!.join(", ")}` : `облік: ${JSON.stringify(r.eligibility ?? {})}`,
      by: r.by,
      source: r.source,
      recordedAt: r.recordedAt,
    });
  }

  for (const r of resolutions) {
    if (!inWindow(r.date, start, end)) continue;
    rows.push({
      date: r.date,
      axis: r.axis,
      summary: `${r.decision}${r.note ? `: ${r.note}` : ""}`,
      by: r.by ?? "",
      source: r.source,
      recordedAt: r.recordedAt,
    });
  }

  for (const a of airbornes) {
    if (!inWindow(a.date, start, end)) continue;
    rows.push({
      date: a.date,
      axis: "airborne",
      summary: `час у повітрі: ${a.minutes} хв${a.note ? ` — ${a.note}` : ""}`,
      by: a.by,
      source: a.source,
      recordedAt: a.recordedAt,
    });
  }

  return rows.sort((x, y) => x.date.localeCompare(y.date) || x.axis.localeCompare(y.axis));
}
