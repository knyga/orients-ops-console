/**
 * Team-facing per-day summary of a period's flight days for #field-qa — one
 * compact Ukrainian mrkdwn line per calendar day (crew, deploy window, airborne,
 * drone counts, status, approver, gate exclusions, links). Never mentions
 * money: pay lives in the bonus report, this is the operational picture.
 * PURE (no DB/Slack/Next) — the CLI `scripts/field-summary.ts` assembles the
 * `SummaryDay[]` from the committed field-verdict / field-bonus / field-qa
 * reports and posts the result chunked.
 */
import type { Period } from "./period";
import { SLACK_MSG_MAX_BYTES, byteLength } from "./slackChunk";

export type SummaryStatus = "ACCEPTED" | "ACCEPTED_EXCEPTION" | "REJECTED" | "NEEDS_REVIEW" | "PENDING";

export interface SummaryDay {
  date: string; // YYYY-MM-DD
  roster: string[];
  deployWindow: { start: string; end: string } | null;
  deployMin: number | null;
  airborneMinutes: number;
  airborneReported: boolean;
  videoMinutes: number;
  status: SummaryStatus;
  early: boolean;
  weekend: boolean;
  droneCounts: { name: string; count: number }[];
  /** false when the day carried no drone data at all (gate could not attribute). */
  droneReportKnown: boolean;
  /** Crew members on an accepted day who are excluded by the per-person drone gate. */
  gateExcluded: string[];
  /** Approver who accepted (exception) or rejected the day, if any. */
  approver: string | null;
  /** Machine reasons (English, from the verdict) — rendered in Ukrainian here. */
  reasons: string[];
  hasZvit: boolean;
  verdictUrl: string | null;
  zvitUrl: string | null;
}

const WEEKDAYS_UK = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_UK_GEN = [
  "січень", "лютий", "березень", "квітень", "травень", "червень",
  "липень", "серпень", "вересень", "жовтень", "листопад", "грудень",
];

function weekdayUk(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return WEEKDAYS_UK[d.getUTCDay()];
}

function ddmm(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

function hoursUk(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} хв`;
  return m === 0 ? `${h} год` : `${h} год ${m} хв`;
}

/** English machine reason → short Ukrainian phrase (falls back to the original). */
export function reasonUk(reason: string): string {
  if (reason.startsWith("exception (") || reason.startsWith("rejected (")) return ""; // approver text is rendered via `approver`
  if (/drones did not fly/.test(reason)) return "за телеметрією польотів не було";
  if (/no #datasets notice/.test(reason)) return "немає датасету";
  if (/flight detected but no Звіт/.test(reason)) return "політ зафіксовано, але немає Звіту";
  if (/airborne time not recorded/.test(reason)) return "час у повітрі не вказано";
  if (/deployment window not recorded/.test(reason)) return "у Звіті не вказано час виїзду";
  const under = /deployment (\d+)m is under 3h/.exec(reason);
  if (under) return `виїзд ${hoursUk(Number(under[1]))} — менше 3 год`;
  const vid = /video (\d+)m is (\d+)% of airborne (\d+)m/.exec(reason);
  if (vid) return `відео ${vid[1]} хв — лише ${vid[2]}% від ${vid[3]} хв у повітрі`;
  if (/no dataset — reason accepted/.test(reason)) return "";
  return reason;
}

function statusUk(day: SummaryDay): string {
  switch (day.status) {
    case "ACCEPTED":
      return "✅ прийнято";
    case "ACCEPTED_EXCEPTION":
      return day.approver ? `✅ прийнято (виняток, ${day.approver})` : "✅ прийнято (виняток)";
    case "REJECTED":
      return day.approver ? `⛔ відхилено (${day.approver})` : "⛔ відхилено";
    case "NEEDS_REVIEW":
      return "⚠️ на перевірці";
    case "PENDING":
      return "⏳ очікує";
  }
}

export function formatDayLine(day: SummaryDay): string {
  const parts: string[] = [];
  parts.push(`*${ddmm(day.date)} ${weekdayUk(day.date)}*`);
  parts.push(day.roster.length ? `екіпаж ${day.roster.join(" + ")}` : "екіпаж —");
  if (day.deployWindow) {
    parts.push(`${day.deployWindow.start}–${day.deployWindow.end}${day.deployMin != null ? ` (${hoursUk(day.deployMin)})` : ""}`);
  } else if (!day.hasZvit) {
    parts.push("немає Звіту");
  }
  if (day.early) parts.push("ранній виїзд");
  if (day.weekend) parts.push("вихідний");
  parts.push(day.airborneReported ? `у повітрі ${Math.round(day.airborneMinutes)} хв` : "у повітрі — не вказано");
  parts.push(`відео ${Math.round(day.videoMinutes)} хв`);
  parts.push(day.droneCounts.length ? `дрони: ${day.droneCounts.map((d) => `${d.name} ${d.count}`).join(", ")}` : "дрони: —");
  parts.push(statusUk(day));

  const notes: string[] = [];
  if (day.status === "NEEDS_REVIEW" || day.status === "PENDING") {
    for (const r of day.reasons) {
      const uk = reasonUk(r);
      if (uk) notes.push(uk);
    }
  }
  if ((day.status === "ACCEPTED" || day.status === "ACCEPTED_EXCEPTION") && day.gateExcluded.length) {
    notes.push(`без свого звіту дронів: ${day.gateExcluded.join(", ")}`);
  }
  if ((day.status === "ACCEPTED" || day.status === "ACCEPTED_EXCEPTION") && !day.droneReportKnown && day.roster.length) {
    notes.push("даних по дронах за день немає");
  }
  if (notes.length) parts.push(notes.join("; "));

  const links: string[] = [];
  if (day.verdictUrl) links.push(`<${day.verdictUrl}|вердикт>`);
  if (day.zvitUrl) links.push(`<${day.zvitUrl}|звіт>`);
  if (links.length) parts.push(links.join(" · "));

  return parts.join(" · ");
}

export interface MonthSummaryPost {
  /** Short channel anchor: header, status counts, legend. No per-day lines. */
  anchor: string;
  /** Thread replies: per-day lines packed under the Slack byte cap, in date order. */
  details: string[];
}

/** Greedy line packer: consecutive lines joined by "\n", each chunk ≤ maxBytes. */
function packLines(lines: string[], maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (cur && byteLength(next) > maxBytes) {
      out.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function buildMonthSummary(period: Period, today: string, days: SummaryDay[]): MonthSummaryPost {
  const month = MONTHS_UK_GEN[Number(period.start.slice(5, 7)) - 1];
  const year = period.start.slice(0, 4);
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const n = (pred: (d: SummaryDay) => boolean) => sorted.filter(pred).length;
  const counts = [
    `✅ ${n((d) => d.status === "ACCEPTED" || d.status === "ACCEPTED_EXCEPTION")}`,
    `⚠️ ${n((d) => d.status === "NEEDS_REVIEW")}`,
    `⛔ ${n((d) => d.status === "REJECTED")}`,
    `⏳ ${n((d) => d.status === "PENDING")}`,
  ].join(" · ");
  const anchor = [
    `*Польові дні — ${month} ${year}* (станом на ${ddmm(today)})`,
    `${sorted.length} днів: ${counts}`,
    "✅ прийнято · ⚠️ на перевірці · ⛔ відхилено · ⏳ очікує (ще в межах 3 робочих днів на відео/датасет)",
    "Деталі по днях — у треді 👇",
  ].join("\n");
  const details = packLines(sorted.map(formatDayLine), SLACK_MSG_MAX_BYTES);
  return { anchor, details };
}
