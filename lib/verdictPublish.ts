/**
 * Pure formatting for the field-day verdict publisher (S4). Turns a DayVerdict
 * into the concise Slack message the bot would post, and decides which days are
 * publishable. No imports beyond the verdict TYPE; unit-tested.
 *
 * Only SETTLED, actionable days are publishable: ACCEPTED, NEEDS_REVIEW,
 * ACCEPTED_EXCEPTION, and REJECTED. PENDING days are still inside the grace
 * window (videos / datasets may yet arrive), so the bot stays quiet about them
 * — posting a "pending" verdict would be noise that flips later.
 */
import { MIN_RATIO } from "./reconcile";
import { MIN_DEPLOY_MIN, MIN_VIDEO_MIN } from "./fieldDayVerdict";
import { dateWithWeekday } from "./workdays";
import type { DayVerdict } from "./fieldDayVerdict";
import { formatDroneLine, type DroneEntry } from "./droneReport";

const ICON: Record<string, string> = {
  ACCEPTED: "✅",
  PENDING: "⏳",
  NEEDS_REVIEW: "⚠️",
  ACCEPTED_EXCEPTION: "🟡",
  REJECTED: "⛔",
};

export const ROSTER_MARKER = "👥 У полі: ";

/** Append the crew suffix line. Empty roster → body unchanged. Pure. */
export function withRosterSuffix(body: string, roster: string[]): string {
  if (roster.length === 0) return body;
  return `${body}\n${ROSTER_MARKER}${roster.join(", ")}.`;
}

export const DRONE_MARKER = "🛸 Дрони: ";

/** Append the drone-count line. Null/empty entries → text unchanged. Pure. */
export function withDroneLine(text: string, entries: DroneEntry[] | undefined): string {
  const line = entries ? formatDroneLine(entries) : null;
  return line ? `${text}\n${line}` : text;
}

/**
 * The day's drone region: the counts when a report exists, an explicit
 * "звіт не подано" when the extraction positively says the day had none
 * (droneReportPresent === false), and nothing when presence is unknown
 * (legacy verdicts predating the extraction — never claim an absence the
 * data can't back). Pure.
 */
export function withDroneRegion(text: string, day: DayVerdict): string {
  const counts = formatDroneLine(day.droneReport ?? []);
  if (counts) return `${text}\n${counts}`;
  if (day.droneReportPresent === false) return `${text}\n${DRONE_MARKER}звіт не подано.`;
  return text;
}

/** Peel a trailing "\n🛸 Дрони: …" line off the end. Pure. */
export function splitDroneLine(text: string): { rest: string; droneLine: string | null } {
  const idx = text.lastIndexOf(`\n${DRONE_MARKER}`);
  if (idx === -1) return { rest: text, droneLine: null };
  const after = text.slice(idx + 1);
  if (after.includes("\n")) return { rest: text, droneLine: null }; // not the trailing line
  return { rest: text.slice(0, idx), droneLine: after };
}

/** Split a published message into body + crew suffix + drone line. The crew
 *  suffix is the line at the last crew marker with any trailing drone line
 *  removed, so parseRosterSuffix stays drone-free. Pure. */
export function splitRosterSuffix(text: string): { body: string; rosterLine: string | null; droneLine: string | null } {
  const { rest, droneLine } = splitDroneLine(text);
  const idx = rest.lastIndexOf(`\n${ROSTER_MARKER}`);
  if (idx === -1) return { body: rest, rosterLine: null, droneLine };
  return { body: rest.slice(0, idx), rosterLine: rest.slice(idx + 1), droneLine };
}

/** Parse the crew names from a published message's crew suffix ([] when none). Pure. */
export function parseRosterSuffix(text: string): string[] {
  const { rosterLine } = splitRosterSuffix(text);
  if (!rosterLine) return [];
  return rosterLine
    .slice(ROSTER_MARKER.length)
    .replace(/\.\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Days the bot will publish a verdict for (settled + actionable). */
export function publishableDays(days: DayVerdict[]): DayVerdict[] {
  return days.filter(
    (d) =>
      d.status === "ACCEPTED" ||
      d.status === "NEEDS_REVIEW" ||
      d.status === "ACCEPTED_EXCEPTION" ||
      d.status === "REJECTED",
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

function datasetMarker(status: DayVerdict["datasetStatus"]): string {
  switch (status) {
    case "POSTED": return "датасет ✓";
    case "WAIVED": return "датасет 📝 виняток";
    case "DECLINED": return "датасет ⛔ відхилено";
    default: return "без датасету"; // MISSING
  }
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
  const ds = datasetMarker(day.datasetStatus);

  if (day.status === "REJECTED") {
    // A human rejection (applyResolution appends `rejected[(by)]: note` last)
    // must surface its note verbatim — machine gaps alone can be empty then.
    const last = day.reasons[day.reasons.length - 1] ?? "";
    const note = /^rejected/.test(last) ? last.replace(/^rejected/, "відхилено") : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    const tail = day.airborneReported && day.airborneMinutes > 0
      ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
      : `(відео ${vid} хв, ${ds})`;
    return withDroneRegion(
      withRosterSuffix(`⛔ ${date} — відхилено: ${parts.join("; ")} ${tail}.`, day.roster),
      day,
    );
  }
  if (day.status === "ACCEPTED") {
    return withDroneRegion(
      withRosterSuffix(`✅ ${date} — прийнято (відео ${vid} хв — це ${pct} від ${air} хв у повітрі; ${ds}).`, day.roster),
      day,
    );
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
    return withDroneRegion(
      withRosterSuffix(`🟡 ${date} — прийнято (виняток): ${parts.join("; ")}.`, day.roster),
      day,
    );
  }
  // NEEDS_REVIEW — rebuild the gaps in Ukrainian from the structured fields.
  const tail = day.airborneReported && day.airborneMinutes > 0
    ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
    : `(відео ${vid} хв, ${ds})`;
  return withDroneRegion(
    withRosterSuffix(`${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} ${tail}.`, day.roster),
    day,
  );
}

/**
 * The flight day's unmet recording-completeness gaps, phrased in Ukrainian and
 * derived purely from the verdict's structured fields (never the English
 * `reasons` strings). Shared by the NEEDS_REVIEW, ACCEPTED_EXCEPTION, and REJECTED renders.
 */
function ukrainianGaps(day: DayVerdict): string[] {
  const air = day.airborneMinutes.toFixed(0);
  const vid = day.videoMinutes.toFixed(0);
  const pct = day.ratio === null ? "—" : `${(day.ratio * 100).toFixed(0)}%`;
  const gaps: string[] = [];
  const videoOk = day.ratio !== null && day.ratio >= MIN_RATIO && day.videoMinutes >= MIN_VIDEO_MIN;
  if (!videoOk) {
    if (day.ratio === null || day.ratio < MIN_RATIO) {
      if (day.ratio === null) {
        gaps.push(
          day.airborneReported
            ? `за телеметрією польотів не було (0 хв у повітрі)${day.deployWindow ? `, хоча у звіті — виїзд ${day.deployWindow.start}–${day.deployWindow.end}` : ""}`
            : `політ відбувся${day.deployWindow ? ` (${day.deployWindow.start}–${day.deployWindow.end})` : ""}, але час у повітрі не вказано`,
        );
      } else {
        gaps.push(`відео ${vid} хв — лише ${pct} від ${air} хв у повітрі (< 50%)`);
      }
    }
  }
  const flew = day.airborneMinutes > 0 || !day.airborneReported;
  if (videoOk === false && day.ratio !== null && day.ratio >= MIN_RATIO) {
    // ratio passed but the absolute floor did not
    gaps.push(`відео ${day.videoMinutes.toFixed(1)} хв — менше ${MIN_VIDEO_MIN} хв`);
  }
  if (flew && day.deployMin != null && day.deployMin < MIN_DEPLOY_MIN) gaps.push(`виїзд ${day.deployMin} хв — менше 3 год`);
  if (flew && day.deployMin === null) gaps.push("у Звіті не вказано час виїзду");
  if (flew && day.droneReportPresent === false) gaps.push("немає звіту про кількість дронів у #field-qa");
  if (flew && day.hasZvit === false) gaps.push("політ зафіксовано, але немає Звіту (екіпаж невідомий)");
  if (day.datasetStatus === "MISSING") gaps.push("немає повідомлення про датасет за цей день");
  if (day.datasetStatus === "DECLINED") gaps.push("датасет відхилено адміністратором");
  return gaps;
}
