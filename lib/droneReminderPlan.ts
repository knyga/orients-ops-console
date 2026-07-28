/**
 * Pure planning for the daily 11:00 drone-count reminder: which drone owners
 * still owe today's submission, and the exact Ukrainian #field-qa message. The
 * FIRST LINE is a stable machine-readable anchor marker — the drone extraction
 * (lib/fieldQaExtract) regexes it to map the reminder's thread to its target
 * date, so a dateless reply in the thread lands on the right day. Change the
 * marker and extraction together. No DB/Next imports; unit-tested.
 */
import { DRONE_OWNERS, type DroneOwner } from "./droneOwners";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** First-line anchor: «🛸 Звіт по дронах за DD.MM». */
const ANCHOR_RE = /^🛸 Звіт по дронах за (\d{2})\.(\d{2})\b/;

/** Render the stable anchor first line for a YYYY-MM-DD date. */
export function droneReminderAnchorLine(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`droneReminderAnchorLine: bad date "${date}"`);
  return `🛸 Звіт по дронах за ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/**
 * The target date of a reminder-anchor message, or null when the text is not an
 * anchor. `postDate` (the message's Kyiv post date) supplies the year — the
 * reminder is always posted on its target day, so DD.MM + the post year is
 * exact.
 */
export function anchorDateFromText(text: string, postDate: string): string | null {
  const m = ANCHOR_RE.exec(text);
  if (!m) return null;
  return `${postDate.slice(0, 4)}-${m[2]}-${m[1]}`;
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
