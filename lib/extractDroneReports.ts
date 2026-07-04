/** Extract per-day drone-count entries from a period's #field-qa messages.
 *  SERVER-ONLY (the default classifier calls Claude). Classifies each
 *  report-candidate MESSAGE individually (a drone-count report is a per-unit
 *  "…шт" tally, so only messages containing "шт" are candidates — chatter never
 *  costs a Claude call). A message yields one report per dated section (a
 *  catch-up message can tally several days at once — the real 06-25 message
 *  carried 23.06/24.06/25.06 sections); each report's entries go to the date it
 *  names (forDate) or, absent that, the Kyiv post date. Per-message
 *  classification is deliberate: joined day-text made results depend on message
 *  order (the 06-02/06-16 misses). Reports are full inventory SNAPSHOTS, not
 *  increments: when a later message reports the same target date, it replaces
 *  the earlier one (the real 06-02 was posted same-day and then restated as
 *  "02.06 Готові" on 06-04 — summing them doubled every entry). Same-date
 *  reports within ONE message still merge (they are sections of one tally).
 *  A per-message classifier failure is NOT swallowed as "no report" —
 *  its (Kyiv post) date is surfaced in `failedDates` so callers can tell "ran,
 *  found none" from "never ran" and skip the drone gate for just that date. */
import "server-only";
import { videoUploadDate } from "./reconcile";
import { classifyDroneCount } from "./droneCountReport";
import { mergeDroneEntries, type DroneEntry } from "./droneReport";
import type { DroneDayReport } from "./droneCountReportPrompt";

export interface DroneMessage {
  ts: string;
  text: string;
}

export type DroneClassifier = (text: string, postedOn?: string) => Promise<{ reports: DroneDayReport[] }>;

const kyivPostDate = (ts: string) => videoUploadDate(new Date(Number(ts) * 1000).toISOString());

/** A report candidate carries at least one per-unit tally ("1шт", "0 шт", …). */
const CANDIDATE = /шт/;

export interface ExtractDroneReportsResult {
  /** date → merged drone entries, for dates where a report was actually found. */
  byDate: Map<string, DroneEntry[]>;
  /** Kyiv post-dates of candidate messages whose classification failed — a
   *  forDate can't be known for a failed classification, so these are dates,
   *  not report attributions. Unknown, not "no report". */
  failedDates: Set<string>;
}

/** Extract per-day drone entries. `classify` is injectable for tests. */
export async function extractDroneReports(
  messages: DroneMessage[],
  classify: DroneClassifier = classifyDroneCount,
): Promise<ExtractDroneReportsResult> {
  const candidates = messages
    .filter((m) => m.text && CANDIDATE.test(m.text))
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const byDate = new Map<string, DroneEntry[]>();
  const failedDates = new Set<string>();
  for (const m of candidates) {
    let reports: DroneDayReport[];
    try {
      ({ reports } = await classify(m.text, kyivPostDate(m.ts)));
    } catch (err) {
      console.error(`extractDroneReports: classifier failed for message ${m.ts}:`, err);
      failedDates.add(kyivPostDate(m.ts));
      continue;
    }
    const perDate = new Map<string, DroneEntry[]>();
    for (const r of reports) {
      if (r.entries.length === 0) continue;
      const target = r.forDate ?? kyivPostDate(m.ts);
      perDate.set(target, [...(perDate.get(target) ?? []), ...r.entries]);
    }
    // Snapshot semantics: this message's tally for a date supersedes any earlier message's.
    for (const [date, entries] of perDate) byDate.set(date, mergeDroneEntries(entries));
  }
  return { byDate, failedDates };
}
