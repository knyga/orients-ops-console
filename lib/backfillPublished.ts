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
 *  - `no-verdict`: no matching day in the report — nothing to render from.
 * `already-current` makes re-runs idempotent (the CLI rewrites the stored text to
 * the new render after posting, so a second pass is a no-op).
 */
import { formatDayMessage } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";
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

/** One item per published day, sorted by date. Pure. */
export function computeBackfillPlan(
  log: PublishedLog,
  verdictByDate: Record<string, DayVerdict>,
): BackfillItem[] {
  return Object.values(log)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      const overridden = entry.override != null;
      const base = { date: entry.date, channel: entry.channel, ts: entry.ts, oldText: entry.text, overridden };
      const verdict = verdictByDate[entry.date];

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
