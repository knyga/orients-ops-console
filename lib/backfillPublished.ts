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
  channel: string;
  ts: string;
  oldText: string;
  newText: string;
  action: "update" | "skip";
  reason: BackfillReason;
  overridden: boolean;
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
      const base = { date: entry.date, channel: entry.channel, ts: entry.ts, oldText: entry.text, overridden };
      // A legacy (reportTs === null) entry resolves to the day's single row when
      // unambiguous; on a multi-report day it is left unresolved (no-verdict skip).
      const verdict =
        rowsByKey.get(reportKey(entry.date, entry.reportTs)) ??
        (entry.reportTs === null && (rowsByDate.get(entry.date) ?? []).length === 1
          ? rowsByDate.get(entry.date)![0]
          : undefined);

      if (!verdict) {
        return { ...base, newText: entry.text, action: "skip" as const, reason: "no-verdict" as const };
      }
      const newText = formatDayMessage(verdict);
      if (overridden) {
        return { ...base, newText, action: "skip" as const, reason: "overridden" as const };
      }
      if (entry.text === newText) {
        return { ...base, newText, action: "skip" as const, reason: "already-current" as const };
      }
      return { ...base, newText, action: "update" as const, reason: "needs-update" as const };
    });
}
