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
 * keyed backfillEditKey(verdictKey, contentRev(newText)), and each edited entry
 * is upserted immediately, so a re-run (or a mid-run failure retried next
 * night) is a no-op.
 */
import "server-only";
import { updateMessage } from "./slack";
import { backfillEditKey, contentRev, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { readPublished, recordPublished, writePublished } from "./published";
import { computeBackfillPlan, type BackfillReason } from "./backfillPublished";
import { isPublishableStatus } from "./verdictPublish";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import type { Period } from "../scripts/fieldPublishReport";

export interface RefreshSkip {
  /** The entry's verdictKey (reportKey(date, reportTs)). */
  key: string;
  reason: BackfillReason | "not-publishable" | "untracked-channel";
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
}

export async function refreshPublishedDays(
  days: DayVerdict[],
  period: Period,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const log = opts.onLog ?? (() => {});
  const trigger = opts.trigger ?? "cron";

  const publishedLog = await readPublished(period);
  const refreshed: string[] = [];
  const skipped: RefreshSkip[] = [];
  for (const item of computeBackfillPlan(publishedLog, days)) {
    const key = reportKey(item.date, item.reportTs);
    if (item.action === "skip") {
      skipped.push({ key, reason: item.reason });
      continue;
    }
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
    await updateMessage(channel.id, item.ts, item.newText, {
      key: backfillEditKey(key, contentRev(item.newText)),
      feature: "verdict",
      channel: channel.name,
      trigger,
    });
    // Rewrite the stored text so a re-run is a no-op; single-entry upsert after
    // EACH edit so a mid-run failure loses nothing.
    await writePublished(period, recordPublished({}, { ...publishedLog[key], text: item.newText }));
    refreshed.push(key);
    log(`field-refresh: updated ${key} in #${channel.name} (ts ${item.ts})`);
  }
  return { refreshed, skipped };
}
