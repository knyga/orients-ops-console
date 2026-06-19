/**
 * Pure scheduler for Policy Execution Tracking. No React/Next/server imports —
 * unit-tested, same discipline as lib/jiraStats.ts.
 *
 * It owns the canonical SlackMessage shape (lib/slack.ts maps Slack's raw
 * response into it), and turns (obligations, messages, period, today) into
 * per-occurrence rows with a DETERMINISTIC status. Verdicts (DONE/LATE/…) are
 * added later by Claude via the CLI's --verdicts-file flow.
 *
 * All calendar math is on YYYY-MM-DD in UTC — consistent with the Jira/GitHub
 * features; public holidays are not modeled (working days = Mon–Fri).
 */
import { activeObligations, type Obligation } from "./policyRegistry";
import type { Period } from "./period";

/** A file attached to a Slack message (subset of fields we use). */
export interface SlackFile {
  name: string;
  mimetype: string;
  /** Authenticated download URL (needs the bot token + files:read). */
  urlPrivate: string;
}

/** A Slack message normalized for scheduling. */
export interface SlackMessage {
  /** Tracked channel NAME (resolved from the channel id by lib/slack). */
  channel: string;
  authorId: string;
  author: string;
  /** Slack ts, e.g. "1716200000.000200". */
  ts: string;
  /** ISO 8601 timestamp derived from ts. */
  isoTime: string;
  text: string;
  /** Permalink, or "" when SLACK_WORKSPACE is unset. */
  permalink: string;
  /** Attached files (e.g. the stats-bot summary image), when present. */
  files?: SlackFile[];
}

export type OccurrenceStatus = "MISSING" | "PENDING" | "NEEDS_REVIEW";

/** A message attached as evidence for an occurrence. */
export interface CandidateMessage {
  authorId: string;
  author: string;
  isoTime: string;
  excerpt: string;
  permalink: string;
}

/** One expected execution of an obligation within the period. */
export interface Occurrence {
  /** Stable id: `${obligationId}:${dueDate}`. */
  id: string;
  obligationId: string;
  title: string;
  channel: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  status: OccurrenceStatus;
  candidates: CandidateMessage[];
}

export interface SkippedObligation {
  obligationId: string;
  reason: string;
}

export interface PolicySchedule {
  period: Period;
  occurrences: Occurrence[];
  skipped: SkippedObligation[];
}

const EXCERPT_LEN = 200;

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fmtDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1=Mon … 7=Sun. */
function isoWeekday(day: string): number {
  const dow = parseDay(day).getUTCDay(); // 0=Sun … 6=Sat
  return dow === 0 ? 7 : dow;
}

export function isWorkingDay(day: string): boolean {
  const wd = isoWeekday(day);
  return wd >= 1 && wd <= 5;
}

/** Add `n` working days (Mon–Fri) to a YYYY-MM-DD date; n=0 returns the input. */
export function addWorkingDays(day: string, n: number): string {
  const date = parseDay(day);
  let added = 0;
  while (added < n) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkingDay(fmtDay(date))) added += 1;
  }
  return fmtDay(date);
}

/** Inclusive list of YYYY-MM-DD dates from start to end. */
function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const date = parseDay(start);
  const last = parseDay(end);
  while (date <= last) {
    out.push(fmtDay(date));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

/** Distinct YYYY-MM month prefixes touched by the period, in order. */
function monthsInPeriod(period: Period): string[] {
  const seen = new Set<string>();
  for (const day of eachDate(period.start, period.end)) seen.add(day.slice(0, 7));
  return [...seen];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Last calendar day (1–31) of a YYYY-MM month, UTC. */
function lastDayOfMonth(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

interface OccurrenceWindow {
  dueDate: string;
  windowStart: string;
}

/** Expected occurrence windows (dueDate + windowStart) for an obligation in the period. */
function occurrenceWindows(ob: Obligation, period: Period): OccurrenceWindow[] {
  const within = (day: string): boolean =>
    day >= period.start &&
    day <= period.end &&
    day >= ob.effectiveFrom &&
    (ob.effectiveTo === undefined || day <= ob.effectiveTo);

  if (ob.cadence.type === "weekly") {
    const weekday = ob.cadence.weekday;
    return eachDate(period.start, period.end)
      .filter((day) => isoWeekday(day) === weekday && within(day))
      .map((day) => ({ dueDate: day, windowStart: day }));
  }

  if (ob.cadence.type === "monthly") {
    const day = ob.cadence.dueDay;
    return monthsInPeriod(period)
      .map((month) => {
        const clamped = Math.min(day, lastDayOfMonth(month));
        return { dueDate: `${month}-${pad2(clamped)}`, windowStart: `${month}-01` };
      })
      .filter((w) => within(w.dueDate));
  }

  return []; // per-event — handled as skipped by the caller
}

function toCandidate(m: SlackMessage): CandidateMessage {
  return {
    authorId: m.authorId,
    author: m.author,
    isoTime: m.isoTime,
    excerpt: m.text.length > EXCERPT_LEN ? `${m.text.slice(0, EXCERPT_LEN)}…` : m.text,
    permalink: m.permalink,
  };
}

/**
 * Build the deterministic schedule. For each active, schedulable obligation,
 * enumerate occurrences, attach candidate messages (same channel, posted within
 * [windowStart, windowEnd] where windowEnd = dueDate + grace working days), and
 * assign a status. Per-event obligations are recorded in `skipped`.
 */
export function buildSchedule(
  obligations: Obligation[],
  messages: SlackMessage[],
  period: Period,
  today: string,
): PolicySchedule {
  const occurrences: Occurrence[] = [];
  const skipped: SkippedObligation[] = [];

  for (const ob of activeObligations(period, obligations)) {
    if (ob.cadence.type === "per-event") {
      skipped.push({ obligationId: ob.id, reason: "per-event cadence not scheduled in v1" });
      continue;
    }
    for (const w of occurrenceWindows(ob, period)) {
      const windowStart = w.windowStart > ob.effectiveFrom ? w.windowStart : ob.effectiveFrom;
      const windowEnd = addWorkingDays(w.dueDate, ob.gracePeriodWorkingDays);
      const candidates = messages
        .filter((m) => {
          const day = m.isoTime.slice(0, 10);
          return m.channel === ob.channel && day >= windowStart && day <= windowEnd;
        })
        .map(toCandidate);
      const status: OccurrenceStatus =
        candidates.length > 0 ? "NEEDS_REVIEW" : today > windowEnd ? "MISSING" : "PENDING";
      occurrences.push({
        id: `${ob.id}:${w.dueDate}`,
        obligationId: ob.id,
        title: ob.title,
        channel: ob.channel,
        dueDate: w.dueDate,
        windowStart,
        windowEnd,
        status,
        candidates,
      });
    }
  }

  occurrences.sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.obligationId.localeCompare(b.obligationId),
  );

  return { period, occurrences, skipped };
}

/**
 * Obligations whose `channel` is not among `knownChannels` (the tracked channel
 * names from lib/slackChannels). Their occurrences can never gather candidate
 * messages — no message ever carries that channel name — so they would silently
 * read as MISSING/PENDING. A non-empty result means the schedule is incomplete;
 * callers (the CLI) should surface it loudly rather than emit misleading rows.
 */
export function unconfiguredObligations(
  obligations: Obligation[],
  knownChannels: string[],
): { obligationId: string; channel: string }[] {
  const known = new Set(knownChannels);
  return obligations
    .filter((o) => !known.has(o.channel))
    .map((o) => ({ obligationId: o.id, channel: o.channel }));
}
