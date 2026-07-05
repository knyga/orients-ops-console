/**
 * Refresh already-published verdict messages against a freshly computed verdict
 * report. SERVER-ONLY (edits Slack + rewrites the published log). Mirrors
 * lib/publishVerdicts.ts in shape: pure planning lives in
 * lib/backfillPublished.computeBackfillPlan (edit only when the stored text
 * differs from the fresh formatDayMessage render; skip overridden entries — the
 * approver strike owns the message — plus no-verdict and already-current ones);
 * this is the effectful driver, called by lib/runNightly per window month.
 *
 * Guards beyond the planner: never rewrite a settled message to a
 * non-publishable (⏳ PENDING) render — grace only shrinks, so it should be
 * unreachable, but the write is outward-facing — and skip entries whose channel
 * is no longer tracked. Idempotent: every key is the entry's verdictKey
 * (reportKey(date, reportTs) — report-exact on multi-report days), edits are
 * keyed backfillEditKey(verdictKey, `${contentRev(newText)}:${runDate}`) —
 * date-salted so a cross-night flip-flop (text A -> B -> A -> B) gets a fresh
 * key each night instead of silently skipping the Slack edit while the DB
 * write-back moves on regardless (permanent silent divergence otherwise) —
 * and each edited entry is upserted immediately, so a re-run (or a mid-run
 * failure retried the same night) is a no-op.
 */
import "server-only";
import { updateMessage } from "./slack";
import { backfillEditKey, contentRev, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { readPublished, recordPublished, writePublished, findPublishedByTs } from "./published";
import { computeBackfillPlan, type BackfillReason } from "./backfillPublished";
import { isPublishableStatus } from "./verdictPublish";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import { FIELD_TIMEZONE } from "./reconcile";
import type { Period } from "../scripts/fieldPublishReport";

export interface RefreshSkip {
  /** The entry's verdictKey (reportKey(date, reportTs)). */
  key: string;
  reason: BackfillReason | "not-publishable" | "untracked-channel" | "changed-since-plan";
}

export interface RefreshResult {
  /** verdictKeys edited (dry-run: that WOULD be edited). */
  refreshed: string[];
  skipped: RefreshSkip[];
}

export interface RefreshOptions {
  dryRun?: boolean;
  onLog?: (message: string) => void;
  /** Audit-log origin recorded for each edit. Default "cron"; a CLI path passes "cli". */
  trigger?: SendTrigger;
  /**
   * The run's calendar day (Europe/Kyiv, YYYY-MM-DD), salted into the edit
   * dedup key (see file doc comment). Defaults to today in Europe/Kyiv;
   * callers invoking this more than once within one logical run (e.g. per
   * window month) should pass the same value so within-run retries still
   * dedup on identical content.
   */
  runDate?: string;
}

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function refreshPublishedDays(
  days: DayVerdict[],
  period: Period,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const log = opts.onLog ?? (() => {});
  const trigger = opts.trigger ?? "cron";
  const runDate = opts.runDate ?? todayInFieldTz();

  const publishedLog = await readPublished(period);
  const refreshed: string[] = [];
  const skipped: RefreshSkip[] = [];
  for (const item of computeBackfillPlan(publishedLog, days)) {
    const key = reportKey(item.date, item.reportTs);
    if (item.action === "skip") {
      skipped.push({ key, reason: item.reason });
      continue;
    }
    // Unreachable for an "update" item — null status is "no-verdict", which the
    // planner reports as action "skip" above — but the check is defensive typing
    // since DayVerdict["status"] | null is the planner's declared type.
    if (item.status === null || !isPublishableStatus(item.status)) {
      skipped.push({ key, reason: "not-publishable" });
      continue;
    }
    const channel = TRACKED_CHANNELS.find((c) => c.name === item.channel);
    if (!channel) {
      skipped.push({ key, reason: "untracked-channel" });
      continue;
    }
    if (opts.dryRun) {
      refreshed.push(key);
      log(`field-refresh (dry-run): would update ${key} in #${channel.name}`);
      continue;
    }
    // TOCTOU guard: re-read this single entry right before editing it. An
    // approver strike or a crew-suffix edit landing between planning and now
    // would otherwise get clobbered in Slack AND spread into the write-back,
    // erasing `override` from the DB. Skip and let the next night reconsider.
    const fresh = await findPublishedByTs(item.ts);
    if (!fresh || fresh.entry.override != null || fresh.entry.text !== item.oldText) {
      skipped.push({ key, reason: "changed-since-plan" });
      continue;
    }
    await updateMessage(channel.id, item.ts, item.newText, {
      key: backfillEditKey(key, `${contentRev(item.newText)}:${runDate}`),
      feature: "verdict",
      channel: channel.name,
      trigger,
    });
    // Rewrite the stored text so a re-run is a no-op; single-entry upsert after
    // EACH edit so a mid-run failure loses nothing. Spread the FRESH entry (not
    // the stale `publishedLog[key]`) so we don't resurrect a field that changed
    // between planning and this edit.
    await writePublished(period, recordPublished({}, { ...fresh.entry, text: item.newText }));
    refreshed.push(key);
    log(`field-refresh: updated ${key} in #${channel.name} (ts ${item.ts})`);
  }
  return { refreshed, skipped };
}
