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
import { MIN_RATIO } from "./reconcile";
import { dateWithWeekday } from "./workdays";
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

export interface OverrideMessages {
  /** New text for the original verdict message: old struck through + amendment. */
  updatedText: string;
  /** The threaded acknowledgement reply. */
  replyText: string;
}

/**
 * Render the two messages for an approver override of a published verdict:
 * the edited original (Slack mrkdwn `~strike~` over the old text + an amendment
 * line) and a short threaded acknowledgement. `originalText` is always the
 * FIRST-posted verdict text, so re-applying after a decision change strikes the
 * original once (never double-strikes). Pure.
 */
export function formatOverride(
  originalText: string,
  decision: "accepted_exception" | "rejected",
  by: string,
  reason: string,
): OverrideMessages {
  const icon = decision === "accepted_exception" ? "🟡" : "⛔";
  const label = decision === "accepted_exception" ? "прийнято (виняток)" : "відхилено";
  return {
    updatedText: `~${originalText}~\n${icon} Оновлено → ${label}, ${by}: ${reason}`,
    replyText: `${icon} Зафіксовано: ${label}, ${by}. Причина: ${reason}`,
  };
}

/**
 * The Slack message text the bot would post for a single day's verdict — in
 * Ukrainian, the field team's language. For NEEDS_REVIEW the gap wording is
 * rebuilt here from the verdict's structured fields (mirroring askGaps.ts), so
 * the English `day.reasons` (kept for the internal web/reports) never leaks to
 * the channel. ACCEPTED_EXCEPTION rebuilds the same gaps and keeps only the
 * human exception note (the last reason) verbatim.
 */
export function formatDayMessage(day: DayVerdict): string {
  const icon = ICON[day.status] ?? "";
  const date = dateWithWeekday(day.date);
  const air = day.airborneMinutes.toFixed(0);
  const vid = day.videoMinutes.toFixed(0);
  const pct = day.ratio === null ? "—" : `${(day.ratio * 100).toFixed(0)}%`;
  const ds = day.datasetPosted ? "датасет ✓" : "без датасету";

  if (day.status === "ACCEPTED") {
    return `✅ ${date} — прийнято (відео ${vid} хв — це ${pct} від ${air} хв у повітрі; ${ds}).`;
  }
  if (day.status === "ACCEPTED_EXCEPTION") {
    // Machine gaps are rebuilt in Ukrainian (the English strings in day.reasons
    // never reach the channel). The human exception note is the LAST reason
    // (applyResolution appends `exception[(by)]: note` last); keep its text
    // verbatim, translating only the `exception` label → `виняток`.
    const note = day.reasons.length
      ? day.reasons[day.reasons.length - 1].replace(/^exception/, "виняток")
      : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    return `🟡 ${date} — прийнято (виняток): ${parts.join("; ")}.`;
  }
  // NEEDS_REVIEW — rebuild the gaps in Ukrainian from the structured fields.
  return `${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} (відео ${vid} хв / ${air} хв у повітрі, ${ds}).`;
}

/**
 * The flight day's unmet recording-completeness gaps, phrased in Ukrainian and
 * derived purely from the verdict's structured fields (never the English
 * `reasons` strings). Shared by the NEEDS_REVIEW and ACCEPTED_EXCEPTION renders.
 */
function ukrainianGaps(day: DayVerdict): string[] {
  const air = day.airborneMinutes.toFixed(0);
  const vid = day.videoMinutes.toFixed(0);
  const pct = day.ratio === null ? "—" : `${(day.ratio * 100).toFixed(0)}%`;
  const gaps: string[] = [];
  const videoOk = day.ratio !== null && day.ratio >= MIN_RATIO;
  if (!videoOk) {
    gaps.push(
      day.ratio === null
        ? "немає записаного часу в повітрі за день"
        : `відео ${vid} хв — лише ${pct} від ${air} хв у повітрі (< 50%)`,
    );
  }
  if (!day.datasetPosted) gaps.push("немає повідомлення про датасет за цей день");
  return gaps;
}
