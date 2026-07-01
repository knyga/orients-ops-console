/**
 * Shared crew-import effect: upsert per-day roster corrections from a parsed
 * crew map (source "field-ops-sheet"), preserving approver/manual corrections
 * (sheetImportShouldSkip). Used by BOTH the `field-crew` CLI (committed CSV) and
 * the nightly cron (live in-memory fetch, see lib/crewLive). No Drive/FS import —
 * the caller supplies the crew map, so this stays a thin DB effect.
 */
import type { DriveSource } from "./driveManifest";
import { readRosterCorrections, upsertRosterCorrection } from "./rosterCorrections";
import { sheetImportShouldSkip } from "./rosterCorrection";

/** The field-ops crew tracking sheet — also registered in reports/drive/manifest.json
 *  (id "field-ops-crew"). Kept here so the nightly can fetch it without reading the
 *  manifest off the read-only serverless filesystem. */
export const FIELD_OPS_CREW_SOURCE: DriveSource = {
  id: "field-ops-crew",
  url: "https://docs.google.com/spreadsheets/d/17xiqiAX9sjevoXR9eJhSeugpqel7h4_QyIgC89nRkK8/edit?gid=99809516",
  type: "sheet",
  dest: "reports/drive/field-ops-crew.csv",
  gid: "99809516",
};

export const CREW_SHEET_SOURCE = "field-ops-sheet";

/**
 * Upsert per-day roster corrections from a parsed crew map, within [start, end].
 * Days where an approver/manual correction already exists are KEPT (not clobbered).
 * DRY-RUN unless `write`. Emits a per-day line via onLog for CLI/cron visibility.
 */
export async function applyCrewCorrections(
  crew: Map<string, string[]>,
  window: { start: string; end: string },
  opts: { write: boolean; onLog?: (m: string) => void },
): Promise<{ applied: number; kept: number; days: number }> {
  const log = opts.onLog ?? (() => {});
  const dates = [...crew.keys()].filter((d) => d >= window.start && d <= window.end).sort();
  const existingSource = new Map((await readRosterCorrections()).map((c) => [c.date, c.source]));

  let applied = 0;
  let kept = 0;
  for (const date of dates) {
    const names = crew.get(date)!;
    const protectedByManual = existingSource.has(date) && sheetImportShouldSkip(existingSource.get(date), CREW_SHEET_SOURCE);
    const tag = protectedByManual ? "keep manual" : opts.write ? "applying" : "would apply";
    log(`• ${date} → [${names.join(", ")}]  (${tag})`);
    if (protectedByManual) { kept += 1; continue; }
    if (opts.write) {
      await upsertRosterCorrection({
        date,
        roster: names,
        note: "Crew from the field-ops tracking sheet (Drive-synced).",
        by: "field-ops sheet",
        source: CREW_SHEET_SOURCE,
        recordedAt: new Date().toISOString(),
      });
      applied += 1;
    }
  }
  return { applied, kept, days: dates.length };
}
