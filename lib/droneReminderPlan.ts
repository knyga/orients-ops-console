/**
 * Pure planning for the daily 09:00 drone-count reminder: which drone owners
 * still owe today's submission, and the exact Ukrainian #field-qa message.
 * The reminder's thread → target-date mapping (for attributing dateless
 * replies) comes from the bot's OWN durable send record (`outbound_messages`
 * rows, feature "drone-reminder"), never from parsing message text — a user
 * message that merely looks like a reminder can't hijack thread attribution.
 * This module owns the outbound key format. No DB/Next imports; unit-tested.
 */
import { DRONE_OWNERS, type DroneOwner } from "./droneOwners";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DRONE_REMINDER_FEATURE = "drone-reminder";

/** The idempotency/outbound key for a date's reminder: "drone-reminder:<date>". */
export function droneReminderKey(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`droneReminderKey: bad date "${date}"`);
  return `${DRONE_REMINDER_FEATURE}:${date}`;
}

/** The date a reminder key targets, or null for a foreign/malformed key. */
export function dateFromDroneReminderKey(key: string): string | null {
  if (!key.startsWith(`${DRONE_REMINDER_FEATURE}:`)) return null;
  const date = key.slice(DRONE_REMINDER_FEATURE.length + 1);
  return DATE_RE.test(date) ? date : null;
}

/** The subset of an outbound_messages row the anchor map needs (structural, so
 *  this module stays DB-free). */
export interface ReminderAnchorSource {
  feature: string;
  status: string;
  ts: string | null;
  key: string;
}

/** Reminder-anchor map (message ts → target date) from the bot's outbound send
 *  record: sent drone-reminder rows with a ts and a parseable key. Pure. */
export function droneReminderAnchors(rows: ReminderAnchorSource[]): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const r of rows) {
    if (r.feature !== DRONE_REMINDER_FEATURE || r.status !== "sent" || !r.ts) continue;
    const date = dateFromDroneReminderKey(r.key);
    if (date) anchors.set(r.ts, date);
  }
  return anchors;
}

/** The human-readable first line for a YYYY-MM-DD date (display only — thread
 *  attribution uses the outbound record above, never this text). */
export function droneReminderAnchorLine(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`droneReminderAnchorLine: bad date "${date}"`);
  return `🛸 Звіт по дронах за ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

export interface DroneReminderPlan {
  /** The exact Ukrainian message to post to #field-qa. */
  text: string;
  /** Owners without a submission for the date — the people tagged. */
  missing: DroneOwner[];
}

/**
 * Plan the day's reminder: tag only the owners who have NOT yet submitted their
 * own drone count for `date`. All submitted → null (post nothing).
 */
export function planDroneReminder(input: {
  date: string;
  submittedUserIds: Iterable<string>;
  owners?: DroneOwner[];
}): DroneReminderPlan | null {
  const owners = input.owners ?? DRONE_OWNERS;
  const submitted = new Set(input.submittedUserIds);
  const missing = owners.filter((o) => !submitted.has(o.userId));
  if (missing.length === 0) return null;
  const tags = missing.map((o) => `<@${o.userId}>`).join(", ");
  const text = [
    droneReminderAnchorLine(input.date),
    `${tags} — будь ласка, вкажіть кількість своїх дронів за сьогодні у треді цього повідомлення. Без вашого звіту бонус за польотний день не нараховується.`,
  ].join("\n");
  return { text, missing };
}
