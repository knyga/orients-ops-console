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
import { mentionize, dementionText } from "./mention";

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
  return `${body}\n${ROSTER_MARKER}${roster.map(mentionize).join(", ")}.`;
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

/** Append the drone-loss line to the BODY region (above 👥/🛸, so the region
 *  splitters and roster/drone edits are untouched). No loss → body unchanged. Pure. */
export function withLossLine(body: string, day: DayVerdict): string {
  if (!day.loss?.lost) return body;
  return `${body}\n${day.loss.found ? "✅ Борт втрачено і знайдено." : "⚠️ Втрата борта (не знайдено)."}`;
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
  return dementionText(rosterLine)
    .slice(ROSTER_MARKER.length)
    .replace(/\.\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Statuses the bot will post/keep posted (settled + actionable) — shared by the publish and refresh drivers. */
export function isPublishableStatus(status: DayVerdict["status"]): boolean {
  return (
    status === "ACCEPTED" ||
    status === "NEEDS_REVIEW" ||
    status === "ACCEPTED_EXCEPTION" ||
    status === "REJECTED"
  );
}

/** Days the bot will publish a verdict for (settled + actionable). */
export function publishableDays(days: DayVerdict[]): DayVerdict[] {
  return days.filter((d) => isPublishableStatus(d.status));
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

/** Format minutes as «N год M хв» (whole hours «N год», sub-hour «M хв»). Pure. */
export function formatDuration(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} хв`;
  if (m === 0) return `${h} год`;
  return `${h} год ${m} хв`;
}

/**
 * The uniform facts tail shown on EVERY published verdict, regardless of
 * status: time in the field (виїзд), time in the air, video minutes/ratio,
 * dataset marker. States facts only — the status clause explains the why.
 * A day that flew without deploy data says «виїзд — не вказано»; a reported
 * no-fly day with no deploy data omits the виїзд segment. Pure.
 */
export function formatTimeTail(day: DayVerdict): string {
  const parts: string[] = [];
  const w = day.deployWindow;
  const dur = typeof day.deployMin === "number" ? formatDuration(day.deployMin) : null;
  const flew = day.airborneMinutes > 0 || !day.airborneReported;
  if (w && dur) parts.push(`виїзд ${w.start}–${w.end} — ${dur}`);
  else if (w) parts.push(`виїзд ${w.start}–${w.end}`);
  else if (dur) parts.push(`виїзд ${dur}`);
  else if (flew) parts.push("виїзд — не вказано");
  parts.push(day.airborneReported ? `у повітрі ${day.airborneMinutes.toFixed(0)} хв` : "у повітрі — не вказано");
  const vid = `відео ${day.videoMinutes.toFixed(0)} хв`;
  parts.push(day.ratio === null ? vid : `${vid} — ${(day.ratio * 100).toFixed(0)}%`);
  parts.push(datasetMarker(day.datasetStatus));
  return `(${parts.join("; ")})`;
}

/**
 * The Slack message text the bot would post for a single day's verdict — in
 * Ukrainian, the field team's language. For NEEDS_REVIEW the gap wording is
 * rebuilt here from the verdict's structured fields (mirroring askGaps.ts), so
 * the English `day.reasons` (kept for the internal web/reports) never leaks to
 * the channel. ACCEPTED_EXCEPTION rebuilds the same gaps and keeps only the
 * human exception note (the last reason) verbatim. Every status ends with the
 * same uniform facts tail (formatTimeTail).
 */
export function formatDayMessage(day: DayVerdict): string {
  const icon = ICON[day.status] ?? "";
  const win = day.deployWindow ? ` (${day.deployWindow.start}–${day.deployWindow.end})` : "";
  const date = day.reportCount > 1
    ? `${dateWithWeekday(day.date)}, виїзд ${day.reportSeq}/${day.reportCount}${win}`
    : dateWithWeekday(day.date);
  const tail = formatTimeTail(day);

  let body: string;
  if (day.status === "REJECTED") {
    // A human rejection (applyResolution appends `rejected[(by)]: note` last)
    // must surface its note verbatim — machine gaps alone can be empty then.
    const last = day.reasons[day.reasons.length - 1] ?? "";
    const note = /^rejected/.test(last) ? last.replace(/^rejected/, "відхилено") : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    body = `⛔ ${date} — відхилено: ${parts.join("; ")} ${tail}.`;
  } else if (day.status === "ACCEPTED") {
    body = `✅ ${date} — прийнято ${tail}.`;
  } else if (day.status === "ACCEPTED_EXCEPTION") {
    // Machine gaps are rebuilt in Ukrainian (the English strings in day.reasons
    // never reach the channel). The human exception note is the LAST reason
    // (applyResolution appends `exception[(by)]: note` last); keep its text
    // verbatim, translating only the `exception` label → `виняток`.
    const note = day.reasons.length
      ? day.reasons[day.reasons.length - 1].replace(/^exception/, "виняток")
      : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    body = `🟡 ${date} — прийнято (виняток): ${parts.join("; ")} ${tail}.`;
  } else {
    // NEEDS_REVIEW — rebuild the gaps in Ukrainian from the structured fields.
    body = `${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} ${tail}.`;
  }
  return withDroneRegion(withRosterSuffix(withLossLine(body, day), day.roster), day);
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
