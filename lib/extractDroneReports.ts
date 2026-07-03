/** Extract per-day drone-count entries from a period's #field-qa messages.
 *  SERVER-ONLY (the default classifier calls Claude). Groups messages by Kyiv
 *  POST date (same-day, matching the bonus gate), classifies each day's joined
 *  text, and attributes the entries to the date the report names (forDate) or,
 *  absent that, the post date. Multiple reports on one target date are merged. */
import "server-only";
import { videoUploadDate } from "./reconcile";
import { classifyDroneCount } from "./droneCountReport";
import { mergeDroneEntries, type DroneEntry } from "./droneReport";

export interface DroneMessage {
  ts: string;
  text: string;
}

export type DroneClassifier = (dayText: string) => Promise<{ entries: DroneEntry[]; forDate: string | null }>;

const kyivPostDate = (ts: string) => videoUploadDate(new Date(Number(ts) * 1000).toISOString());

/** date → merged drone entries. `classify` is injectable for tests. */
export async function extractDroneReports(
  messages: DroneMessage[],
  classify: DroneClassifier = classifyDroneCount,
): Promise<Map<string, DroneEntry[]>> {
  const textByPostDate = new Map<string, string[]>();
  for (const m of messages) {
    if (!m.text) continue;
    const d = kyivPostDate(m.ts);
    const arr = textByPostDate.get(d) ?? [];
    arr.push(m.text);
    textByPostDate.set(d, arr);
  }

  const byDate = new Map<string, DroneEntry[]>();
  for (const [postDate, texts] of textByPostDate) {
    let entries: DroneEntry[];
    let forDate: string | null;
    try {
      ({ entries, forDate } = await classify(texts.join("\n\n")));
    } catch (err) {
      console.error(`extractDroneReports: classifier failed for ${postDate}:`, err);
      entries = [];
      forDate = null;
    }
    if (entries.length === 0) continue;
    const target = forDate ?? postDate;
    byDate.set(target, [...(byDate.get(target) ?? []), ...entries]);
  }
  for (const [date, entries] of byDate) byDate.set(date, mergeDroneEntries(entries));
  return byDate;
}
