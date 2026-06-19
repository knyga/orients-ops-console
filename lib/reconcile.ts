/**
 * Pure reconciliation logic for the Orients field-ops video gate.
 *
 * Policy (current 2026-04):
 *  - Video is NOT summed into a payout. There are no per-video / per-minute bonuses.
 *  - Recording completeness GATES the daily field bonus: for a flight day to count,
 *    the recorded Vimeo video minutes must be >= 50% of the flight minutes for that
 *    day (internal Vimeo is the source of truth).
 *  - Below 50%, or a flight day with zero video, is FLAGGED for manual review.
 *    A FLAG never auto-rejects — force-majeure / tech-failure exceptions exist, so
 *    FLAG means "needs a human decision".
 *  - Publication lag: a flight's video may be uploaded up to one working day later.
 *    Days are grouped by UPLOAD date (created_time), surfaced as a UI caveat.
 *
 * No React / Next imports — this module is pure and unit-tested.
 */

/** The reconciliation gate: recorded minutes must be at least this fraction of
 * flight minutes for a flight day to be OK. Comparison uses `>=`, so an exact
 * 50% match (e.g. 2h flight / 1h video) passes. */
export const MIN_RATIO = 0.5;

/** Day boundaries follow the field team's operational timezone, not UTC. */
export const FIELD_TIMEZONE = "Europe/Kyiv";

export type ReconStatus = "OK" | "FLAG";

/** A video reduced to the only fields reconciliation cares about. */
export interface ReconVideo {
  /** Upload time as an ISO 8601 string (Vimeo `created_time`). */
  createdTime: string;
  /** Video length in seconds (Vimeo `duration`). */
  durationSeconds: number;
}

/** Manually-entered (ephemeral) flight hours for a single calendar day. */
export interface FlightDay {
  /** Calendar day in `YYYY-MM-DD` (field timezone). */
  date: string;
  /** Total flight hours logged for that day. */
  flightHours: number;
}

/** One row of the daily reconciliation table. */
export interface DailyRecon {
  /** Calendar day in `YYYY-MM-DD` (field timezone). */
  date: string;
  /** Number of videos uploaded on this day. */
  videoCount: number;
  /** Sum of video durations for the day, in minutes. */
  recordedMinutes: number;
  /** Flight minutes logged for the day (flightHours * 60). */
  flightMinutes: number;
  /** recordedMinutes / flightMinutes, or null when there are no flight minutes. */
  ratio: number | null;
  status: ReconStatus;
}

export interface PeriodSummary {
  totalVideos: number;
  totalRecordedMinutes: number;
  /** Dates (YYYY-MM-DD) whose reconciliation status is FLAG. */
  flaggedDays: string[];
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  // `en-CA` renders as YYYY-MM-DD. The timezone makes the day boundary
  // DST-correct for the field team rather than UTC-based.
  timeZone: FIELD_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Map a video's ISO upload time to its calendar day (YYYY-MM-DD) in the field
 * timezone. A flight recorded just after local midnight belongs to the local
 * date, even when that differs from the UTC date.
 */
export function videoUploadDate(createdTime: string): string {
  const parsed = new Date(createdTime);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid created_time: ${createdTime}`);
  }
  return dayFormatter.format(parsed);
}

// Match YYYY-MM-DD or YYYYMMDD anywhere in the name. Capture the parts so we can
// validate the calendar date (a real date, not e.g. WIN_20261399). Global so we
// can try every date-like run and take the first that is a real calendar date.
const NAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})/g;

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible day-of-month (e.g. 2026-02-31) via round-trip.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/**
 * The flight day a video belongs to. Uploads lag the flight by up to the grace
 * window, so the flight date is taken from the video NAME — two observed formats,
 * `Recording YYYY-MM-DD …` and `WIN_YYYYMMDD_…`. Falls back to the Kyiv upload
 * date only when the name carries no parseable calendar date.
 * See docs/.../field-day-acceptance spec + memory video-name-carries-flight-date.
 */
export function videoFlightDate(name: string, createdTime: string): string {
  // Try every date-like run; return the first that is a real calendar date, so a
  // spurious leading digit run before the true date doesn't force the fallback.
  for (const m of (name ?? "").matchAll(NAME_DATE_RE)) {
    const iso = m[1]
      ? validDate(Number(m[1]), Number(m[2]), Number(m[3]))
      : validDate(Number(m[4]), Number(m[5]), Number(m[6]));
    if (iso) return iso;
  }
  return videoUploadDate(createdTime);
}

interface DayAccumulator {
  videoCount: number;
  recordedSeconds: number;
  flightHours: number;
  hasFlightDay: boolean;
}

function statusFor(flightMinutes: number, ratio: number | null): ReconStatus {
  // A flight day passes only when video covers at least MIN_RATIO of flight time.
  if (flightMinutes > 0) {
    return ratio !== null && ratio >= MIN_RATIO ? "OK" : "FLAG";
  }
  // No flight minutes for a day that nonetheless has video (or a 0-hour flight
  // entry): unexplained recording — needs a human decision, so FLAG.
  return "FLAG";
}

/**
 * Aggregate videos (grouped by upload day) against logged flight hours and
 * apply the 50% gate. Returns one row per day that has either video or a flight
 * entry, sorted ascending by date.
 */
export function aggregateByDay(
  videos: ReconVideo[],
  flightDays: FlightDay[],
): DailyRecon[] {
  const days = new Map<string, DayAccumulator>();

  const ensure = (date: string): DayAccumulator => {
    let acc = days.get(date);
    if (!acc) {
      acc = {
        videoCount: 0,
        recordedSeconds: 0,
        flightHours: 0,
        hasFlightDay: false,
      };
      days.set(date, acc);
    }
    return acc;
  };

  for (const video of videos) {
    const acc = ensure(videoUploadDate(video.createdTime));
    acc.videoCount += 1;
    acc.recordedSeconds += video.durationSeconds;
  }

  for (const flight of flightDays) {
    const acc = ensure(flight.date);
    // Sum if a date appears more than once (two flights logged the same day),
    // matching toFlightDays in lib/flightHours.ts.
    acc.flightHours += flight.flightHours;
    acc.hasFlightDay = true;
  }

  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, acc]) => {
      const recordedMinutes = acc.recordedSeconds / 60;
      const flightMinutes = acc.flightHours * 60;
      const ratio = flightMinutes > 0 ? recordedMinutes / flightMinutes : null;
      return {
        date,
        videoCount: acc.videoCount,
        recordedMinutes,
        flightMinutes,
        ratio,
        status: statusFor(flightMinutes, ratio),
      };
    });
}

/** Roll up daily rows into period totals plus the list of flagged days. */
export function summarize(daily: DailyRecon[]): PeriodSummary {
  return daily.reduce<PeriodSummary>(
    (summary, day) => {
      summary.totalVideos += day.videoCount;
      summary.totalRecordedMinutes += day.recordedMinutes;
      if (day.status === "FLAG") {
        summary.flaggedDays.push(day.date);
      }
      return summary;
    },
    { totalVideos: 0, totalRecordedMinutes: 0, flaggedDays: [] },
  );
}
