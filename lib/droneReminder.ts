/**
 * The daily 11:00 drone-count reminder. SERVER-ONLY (live Slack + the cached
 * Claude drone classifier). One source of truth for BOTH the
 * `/api/cron/drone-reminder` route and the `drone-reminder` CLI: fetch today's
 * #field-qa messages (incl. thread replies), work out which drone owners
 * already submitted their OWN count for today, and — only when someone is
 * missing — post the Ukrainian reminder tagging exactly those people. The
 * reminder is the day's thread anchor: its outbound send record (feature
 * "drone-reminder", key "drone-reminder:<date>") maps its thread to the target
 * date, so the extraction attributes dateless replies in its thread to today.
 *
 * Idempotent: the post keys `drone-reminder:<date>` at the lib/slack reserve-
 * then-send chokepoint, so a cron re-fire posts once. All submitted → no post.
 */
import "server-only";
import { fetchRawMessages, postMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { todayInFieldTz } from "./syncChannels";
import { extractDroneReportsCached } from "./extractDroneReports";
import { DRONE_REMINDER_FEATURE, droneReminderAnchors, droneReminderKey, planDroneReminder } from "./droneReminderPlan";
import { readOutbound } from "./outbound";
import type { SendTrigger } from "./outboundKeys";

const FIELD_QA = "field-qa";

/** The previous calendar day of a YYYY-MM-DD date. */
function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export interface DroneReminderResult {
  date: string;
  /** Owners already submitted for the date (user ids). */
  submitted: string[];
  /** Roster names of the owners the reminder tags ([] when all submitted). */
  missing: string[];
  /** The exact message (null when all submitted → nothing to post). */
  text: string | null;
  /** true only when a real post went out this run (publish + not deduped-away). */
  posted: boolean;
}

export interface RunDroneReminderOptions {
  publish: boolean;
  /** The "today" calendar day (field tz). Defaults to today. */
  today?: string;
  trigger?: SendTrigger;
  onLog?: (message: string) => void;
}

export async function runDroneReminder(opts: RunDroneReminderOptions): Promise<DroneReminderResult> {
  const log = opts.onLog ?? (() => {});
  const today = opts.today ?? todayInFieldTz();
  const channel = TRACKED_CHANNELS.find((c) => c.name === FIELD_QA);
  if (!channel) throw new Error(`drone-reminder: no tracked channel "${FIELD_QA}"`);

  // Yesterday + today's #field-qa messages incl. thread replies — one day of
  // lookback so a previous-evening submission with an explicit «за DD.MM» date
  // for today still counts at 11:00. Anchors come from the bot's outbound send
  // record (never message text). Extraction runs behind the shared drone cache,
  // so this run is near-free on Claude.
  const window = { start: dayBefore(today), end: today };
  const messages = await fetchRawMessages(window, [channel]);
  const anchorDateByThreadTs = droneReminderAnchors(await readOutbound(window));
  const { submittersByDate, misses } = await extractDroneReportsCached(
    messages.map((m) => ({ ts: m.ts, text: m.text, authorId: m.authorId, threadTs: m.thread_ts })),
    anchorDateByThreadTs,
  );
  log(`drone-reminder: ${messages.length} message(s) in ${window.start}..${window.end}, ${misses} Claude call(s) (rest cached)`);

  const submitted = [...(submittersByDate.get(today) ?? new Set<string>())];
  const plan = planDroneReminder({ date: today, submittedUserIds: submitted });
  if (!plan) {
    log(`drone-reminder: all drone owners submitted for ${today} — nothing to post`);
    return { date: today, submitted, missing: [], text: null, posted: false };
  }

  const missing = plan.missing.map((o) => o.rosterName);
  if (!opts.publish) {
    log(`drone-reminder: DRY RUN — would tag ${missing.join(", ")} in #${channel.name}`);
    return { date: today, submitted, missing, text: plan.text, posted: false };
  }

  await postMessage(channel.id, plan.text, {
    key: droneReminderKey(today),
    feature: DRONE_REMINDER_FEATURE,
    channel: channel.name,
    trigger: opts.trigger ?? "cron",
  });
  log(`drone-reminder: posted to #${channel.name}, tagged ${missing.join(", ")}`);
  return { date: today, submitted, missing, text: plan.text, posted: true };
}
