/**
 * Pure planner for the one-time backfill that rewrites already-published verdict
 * messages to the current Ukrainian format (lib/verdictPublish.formatDayMessage).
 * No DB/Slack/fs here — the CLI (scripts/field-backfill.ts) supplies the
 * DB-sourced published log + verdicts and performs the chat.update writes.
 *
 * An item is `update` only when its stored text differs from the fresh render.
 * Two cases are deliberately SKIPPED:
 *  - `overridden`: the live message is a struck approver amendment (+ a separate
 *    ack reply) — re-rendering the plain verdict would clobber it.
 *  - `no-verdict`: no matching report row for this entry — nothing to render
 *    from. This also covers a legacy (bare-date) entry that lands on a day that
 *    now has MULTIPLE reports — ambiguous, so it is skipped rather than guessed.
 * `already-current` makes re-runs idempotent (the CLI rewrites the stored text to
 * the new render after posting, so a second pass is a no-op).
 */
import { formatDayMessage } from "./verdictPublish";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import type { PublishedLog } from "./published";

export type BackfillReason = "needs-update" | "already-current" | "overridden" | "no-verdict";

export interface BackfillItem {
  date: string;
  /** The published entry's report identity — the exact write-back key
   *  (reportKey(date, reportTs)); null for a legacy pre-per-report entry. */
  reportTs: string | null;
  /** The matched verdict row's report position, when one was found (for the
   *  «виїзд N/M» display label). Absent (1/1) when no verdict matched. */
  reportSeq: number;
  reportCount: number;
  channel: string;
  ts: string;
  oldText: string;
  newText: string;
  action: "update" | "skip";
  reason: BackfillReason;
  overridden: boolean;
  /** The matched verdict's status; null when no verdict matched (reason "no-verdict"). */
  status: DayVerdict["status"] | null;
}

/** One item per published entry, sorted by date. Pure. */
export function computeBackfillPlan(
  log: PublishedLog,
  verdicts: DayVerdict[],
): BackfillItem[] {
  const rowsByKey = new Map(verdicts.map((d) => [reportKey(d.date, d.reportTs), d]));
  const rowsByDate = new Map<string, DayVerdict[]>();
  for (const d of verdicts) {
    const list = rowsByDate.get(d.date) ?? [];
    list.push(d);
    rowsByDate.set(d.date, list);
  }

  return Object.values(log)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      const overridden = entry.override != null;
      // The write-back identity is always the ENTRY's own (date, reportTs) — the
      // exact key it was read from (identical to a legacy bare date when
      // reportTs is null), never the matched verdict's — so a re-run edits the
      // same published row it read.
      const base = {
        date: entry.date,
        reportTs: entry.reportTs,
        channel: entry.channel,
        ts: entry.ts,
        oldText: entry.text,
        overridden,
      };
      // A legacy (reportTs === null) entry resolves to the day's single row when
      // unambiguous; on a multi-report day it is left unresolved (no-verdict skip).
      const verdict =
        rowsByKey.get(reportKey(entry.date, entry.reportTs)) ??
        (entry.reportTs === null && (rowsByDate.get(entry.date) ?? []).length === 1
          ? rowsByDate.get(entry.date)![0]
          : undefined);

      if (!verdict) {
        return { ...base, reportSeq: 1, reportCount: 1, newText: entry.text, action: "skip" as const, reason: "no-verdict" as const, status: null };
      }
      const withReportMeta = { ...base, reportSeq: verdict.reportSeq, reportCount: verdict.reportCount, status: verdict.status };
      const newText = formatDayMessage(verdict);
      if (overridden) {
        return { ...withReportMeta, newText, action: "skip" as const, reason: "overridden" as const };
      }
      if (entry.text === newText) {
        return { ...withReportMeta, newText, action: "skip" as const, reason: "already-current" as const };
      }
      return { ...withReportMeta, newText, action: "update" as const, reason: "needs-update" as const };
    });
}
