/** Extract per-day drone-count entries from a period's #field-qa messages.
 *  SERVER-ONLY (the default classifier calls Claude). Classifies each
 *  report-candidate MESSAGE individually (a drone-count report is a per-unit
 *  "…шт" tally, so only messages containing "шт" — or any reply inside a
 *  drone-reminder thread — are candidates; chatter never costs a Claude call).
 *  A message yields one report per dated section (a catch-up message can tally
 *  several days at once — the real 06-25 message carried 23.06/24.06/25.06
 *  sections); each report's entries go to the date it names (forDate) or,
 *  absent that, the message's DEFAULT date: the reminder anchor's date for a
 *  reply inside a reminder thread, else the Kyiv post date. Per-message
 *  classification is deliberate: joined day-text made results depend on message
 *  order (the 06-02/06-16 misses).
 *
 *  Since 2026-07-28 pilots submit counts INDEPENDENTLY, so snapshots are per
 *  (date, author): a later message by the SAME author for a date replaces that
 *  author's earlier tally (the restated-inventory case), while different
 *  authors' same-date reports MERGE — the old whole-date replace let pilot 2's
 *  message wipe pilot 1's counts. Same-date sections within ONE message still
 *  merge (they are sections of one tally). `submittersByDate` records which
 *  authors submitted for each date — the per-person bonus gate's input.
 *
 *  A per-message classifier failure is NOT swallowed as "no report" — its
 *  default date is surfaced in `failedDates` so callers can tell "ran, found
 *  none" from "never ran" and skip the drone gate for just that date. */
import "server-only";
import { videoUploadDate } from "./reconcile";
import { classifyDroneCount } from "./droneCountReport";
import { mergeDroneEntries, type DroneEntry } from "./droneReport";
import { droneOwnerForUserId } from "./droneOwners";
import { dbExtractCacheStore, droneKey, makeCachedDroneClassifier } from "./extractCache";
import type { DroneDayReport } from "./droneCountReportPrompt";

export interface DroneMessage {
  ts: string;
  text: string;
  /** Slack author user id — the per-person gate's attribution key. */
  authorId?: string;
  /** Parent thread ts when the message is a thread reply. */
  threadTs?: string;
}

export type DroneClassifier = (text: string, postedOn?: string) => Promise<{ reports: DroneDayReport[] }>;

export const kyivPostDate = (ts: string) => videoUploadDate(new Date(Number(ts) * 1000).toISOString());

/** A report candidate carries at least one per-unit tally ("1шт", "0 шт", …). */
const CANDIDATE = /шт/;

/** The "" author key for messages with no author id. Its per-date snapshots
 *  merge under one shared key (later such message replaces the earlier — same
 *  as any single author) and it is never reported as a submitter. */
const UNKNOWN_AUTHOR = "";

/** The date a report defaults to when its text names none: the reminder
 *  anchor's target date for a reply inside a reminder thread, else the Kyiv
 *  post date. THE cache-key input — every caller preloading the drone cache
 *  must key with this exact rule (extractDroneReportsCached owns that). */
export function defaultDateFor(
  m: { ts: string; threadTs?: string },
  anchors: Map<string, string>,
): string {
  return (m.threadTs !== undefined && anchors.get(m.threadTs)) || kyivPostDate(m.ts);
}

export interface ExtractDroneReportsOptions {
  /** Reminder-anchor thread ts → the date that anchor targets. A reply inside
   *  such a thread is always a candidate, and its dateless reports default to
   *  the anchor's date instead of the reply's post date. */
  anchorDateByThreadTs?: Map<string, string>;
}

export interface ExtractDroneReportsResult {
  /** date → merged drone entries across all authors (display), for dates where
   *  a report was actually found. */
  byDate: Map<string, DroneEntry[]>;
  /** date → author ids with at least one entry for that date — the per-person
   *  drone-count gate's attribution input. */
  submittersByDate: Map<string, Set<string>>;
  /** Default dates of candidate messages whose classification failed — a
   *  forDate can't be known for a failed classification, so these are dates,
   *  not report attributions. Unknown, not "no report". */
  failedDates: Set<string>;
}

/** A drone owner's own tally that names no person ("2шт вартовий") is theirs:
 *  re-attribute it to the author so the 🛸 display line shows them. Pure. */
function attributeToOwner(entries: DroneEntry[], authorId: string | undefined): DroneEntry[] {
  const owner = authorId ? droneOwnerForUserId(authorId) : undefined;
  if (!owner || entries.some((e) => e.isPerson)) return entries;
  return entries.map((e) => ({ name: owner.rosterName, isPerson: true, count: e.count }));
}

/** Extract per-day drone entries. `classify` is injectable for tests. */
export async function extractDroneReports(
  messages: DroneMessage[],
  classify: DroneClassifier = classifyDroneCount,
  opts: ExtractDroneReportsOptions = {},
): Promise<ExtractDroneReportsResult> {
  const anchors = opts.anchorDateByThreadTs ?? new Map<string, string>();
  const candidates = messages
    .filter(
      (m) =>
        m.text &&
        // The reminder anchor itself is never a submission — skip it so a
        // replied-to reminder doesn't burn a classify call every run.
        !anchors.has(m.ts) &&
        (CANDIDATE.test(m.text) || (m.threadTs !== undefined && anchors.has(m.threadTs))),
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  // date → author id → that author's latest snapshot for the date.
  const byAuthorDate = new Map<string, Map<string, DroneEntry[]>>();
  const failedDates = new Set<string>();
  for (const m of candidates) {
    const defaultDate = defaultDateFor(m, anchors);
    let reports: DroneDayReport[];
    try {
      ({ reports } = await classify(m.text, defaultDate));
    } catch (err) {
      console.error(`extractDroneReports: classifier failed for message ${m.ts}:`, err);
      failedDates.add(defaultDate);
      continue;
    }
    const perDate = new Map<string, DroneEntry[]>();
    for (const r of reports) {
      if (r.entries.length === 0) continue;
      const target = r.forDate ?? defaultDate;
      perDate.set(target, [...(perDate.get(target) ?? []), ...r.entries]);
    }
    // Per-author snapshot semantics: this author's tally for a date supersedes
    // THEIR earlier message's; other authors' same-date tallies are untouched.
    const author = m.authorId ?? UNKNOWN_AUTHOR;
    for (const [date, entries] of perDate) {
      const perAuthor = byAuthorDate.get(date) ?? new Map<string, DroneEntry[]>();
      perAuthor.set(author, mergeDroneEntries(attributeToOwner(entries, m.authorId)));
      byAuthorDate.set(date, perAuthor);
    }
  }

  const byDate = new Map<string, DroneEntry[]>();
  const submittersByDate = new Map<string, Set<string>>();
  for (const [date, perAuthor] of byAuthorDate) {
    byDate.set(date, mergeDroneEntries([...perAuthor.values()].flat()));
    submittersByDate.set(date, new Set([...perAuthor.keys()].filter((a) => a !== UNKNOWN_AUTHOR)));
  }
  return { byDate, submittersByDate, failedDates };
}

/**
 * The production entry point: extractDroneReports behind the shared
 * content-addressed Claude cache (`extract_cache`, kind "drone"). Owns the
 * preload so the cache key and the classifier's default date CANNOT diverge —
 * both come from defaultDateFor. Returns the extraction result plus the number
 * of real Claude calls (`misses`). Used by the field-qa extract and the
 * drone-reminder; unit tests keep injecting a classifier into the base fn.
 */
export async function extractDroneReportsCached(
  messages: DroneMessage[],
  anchorDateByThreadTs: Map<string, string>,
): Promise<ExtractDroneReportsResult & { misses: number }> {
  const store = dbExtractCacheStore("drone");
  const preloaded = await store.readMany(
    messages.map((m) => droneKey(m.text, defaultDateFor(m, anchorDateByThreadTs))),
  );
  const { classifier, misses } = makeCachedDroneClassifier(store, preloaded, classifyDroneCount);
  const result = await extractDroneReports(messages, classifier, { anchorDateByThreadTs });
  return { ...result, misses: misses() };
}
