/**
 * Pure formatting for the field-day verdict publisher (S4). Turns a DayVerdict
 * into the concise Slack message the bot would post, and decides which days are
 * publishable. No imports beyond the verdict TYPE; unit-tested.
 *
 * Only SETTLED, actionable days are publishable: ACCEPTED, NEEDS_REVIEW, and
 * ACCEPTED_EXCEPTION. PENDING days are still inside the grace window (videos /
 * datasets may yet arrive), so the bot stays quiet about them — posting a
 * "pending" verdict would be noise that flips later.
 */
import type { DayVerdict } from "./fieldDayVerdict";

const ICON: Record<string, string> = {
  ACCEPTED: "✅",
  PENDING: "⏳",
  NEEDS_REVIEW: "⚠️",
  ACCEPTED_EXCEPTION: "🟡",
};

/** Days the bot will publish a verdict for (settled + actionable). */
export function publishableDays(days: DayVerdict[]): DayVerdict[] {
  return days.filter(
    (d) =>
      d.status === "ACCEPTED" ||
      d.status === "NEEDS_REVIEW" ||
      d.status === "ACCEPTED_EXCEPTION",
  );
}

/** The Slack message text the bot would post for a single day's verdict. */
export function formatDayMessage(day: DayVerdict): string {
  const icon = ICON[day.status] ?? "";
  const air = day.airborneMinutes.toFixed(0);
  const vid = day.videoMinutes.toFixed(0);
  const pct = day.ratio === null ? "—" : `${(day.ratio * 100).toFixed(0)}%`;
  const ds = day.datasetPosted ? "dataset ✓" : "no dataset";

  if (day.status === "ACCEPTED") {
    return `✅ ${day.date} — accepted (video ${vid}m is ${pct} of ${air}m airborne; ${ds}).`;
  }
  if (day.status === "ACCEPTED_EXCEPTION") {
    return `🟡 ${day.date} — accepted (exception): ${day.reasons.join("; ")}.`;
  }
  // NEEDS_REVIEW
  return `${icon} ${day.date} — needs review: ${day.reasons.join("; ")} (video ${vid}m / ${air}m airborne, ${ds}).`;
}
