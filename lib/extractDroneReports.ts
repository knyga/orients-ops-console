/** Extract per-day drone-count entries from a period's #field-qa messages.
 *  SERVER-ONLY (the default classifier calls Claude). Classifies each
 *  report-candidate MESSAGE individually (a drone-count report is a per-unit
 *  "…шт" tally, so only messages containing "шт" are candidates — chatter never
 *  costs a Claude call). A message yields one report per dated section (a
 *  catch-up message can tally several days at once — the real 06-25 message
 *  carried 23.06/24.06/25.06 sections); each report's entries go to the date it
 *  names (forDate) or, absent that, the Kyiv post date. Per-message
 *  classification is deliberate: joined day-text made results depend on message
 *  order (the 06-02/06-16 misses). Multiple reports on one target date are
 *  merged. */
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

/** date → merged drone entries. `classify` is injectable for tests. */
export async function extractDroneReports(
  messages: DroneMessage[],
  classify: DroneClassifier = classifyDroneCount,
): Promise<Map<string, DroneEntry[]>> {
  const candidates = messages
    .filter((m) => m.text && CANDIDATE.test(m.text))
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const byDate = new Map<string, DroneEntry[]>();
  for (const m of candidates) {
    let reports: DroneDayReport[];
    try {
      ({ reports } = await classify(m.text, kyivPostDate(m.ts)));
    } catch (err) {
      console.error(`extractDroneReports: classifier failed for message ${m.ts}:`, err);
      continue;
    }
    for (const r of reports) {
      if (r.entries.length === 0) continue;
      const target = r.forDate ?? kyivPostDate(m.ts);
      byDate.set(target, [...(byDate.get(target) ?? []), ...r.entries]);
    }
  }
  for (const [date, entries] of byDate) byDate.set(date, mergeDroneEntries(entries));
  return byDate;
}
