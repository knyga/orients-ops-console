/**
 * Shared verdict-publishing orchestration. SERVER-ONLY (posts to Slack + writes
 * the DB published log). One source of truth for the real-post loop, called by
 * BOTH the `field-publish` CLI (real path) and the `/api/cron/field-nightly`
 * route. Pure formatting/selection stays in lib/verdictPublish; this is the
 * effectful driver, mirroring lib/computeVerdicts.
 *
 * Posts only SETTLED days (publishableDays: ACCEPTED / NEEDS_REVIEW /
 * ACCEPTED_EXCEPTION — never PENDING) that are not already in the published log.
 * Idempotent: the published log is persisted after EACH post so a mid-run failure
 * never re-posts an already-sent day.
 */
import "server-only";
import { postMessage } from "./slack";
import { verdictKey } from "./outboundKeys";
import { periodKey } from "./reports";
import { isPublished, readPublished, recordPublished, writePublished } from "./published";
import { formatDayMessage, publishableDays } from "./verdictPublish";
import type { SlackChannel } from "./slackChannels";
import type { DayVerdict } from "./fieldDayVerdict";
import type { SendTrigger } from "./outboundKeys";
import type { Period } from "../scripts/fieldPublishReport";

export interface PublishResult {
  posted: string[];
  skipped: string[];
}

export interface PublishSettledOptions {
  onLog?: (message: string) => void;
  /** Audit-log origin recorded for each post. Default "cron"; the CLI passes "cli". */
  trigger?: SendTrigger;
}

export async function publishSettledDays(
  days: DayVerdict[],
  channel: SlackChannel,
  period: Period,
  opts: PublishSettledOptions = {},
): Promise<PublishResult> {
  const log = opts.onLog ?? (() => {});
  const trigger = opts.trigger ?? "cron";
  const key = periodKey(period);
  let publishedLog = await readPublished(period);

  const posted: string[] = [];
  const skipped: string[] = [];
  for (const day of publishableDays(days)) {
    if (isPublished(publishedLog, day.date)) {
      skipped.push(day.date);
      continue;
    }
    const text = formatDayMessage(day);
    const ts = await postMessage(channel.id, text, {
      key: verdictKey(key, day.date),
      feature: "verdict",
      channel: channel.name,
      trigger,
    });
    publishedLog = recordPublished(publishedLog, {
      date: day.date,
      channel: channel.name,
      text,
      postedAt: new Date().toISOString(),
      ts,
    });
    await writePublished(period, publishedLog); // persist after each post
    posted.push(day.date);
    log(`field-publish: posted ${day.date} to #${channel.name} (ts ${ts})`);
  }
  return { posted, skipped };
}
