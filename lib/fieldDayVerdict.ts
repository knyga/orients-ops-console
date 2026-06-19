/**
 * Pure per-flight-day acceptance verdict for the field bonus. Operationalizes the
 * recording-completeness gate: a day is ACCEPTED when, within the grace window,
 * Vimeo video minutes ≥ MIN_RATIO × airborne minutes AND a #datasets notice
 * exists. Inside the window with a condition unmet → PENDING. After the window
 * with a condition unmet → NEEDS_REVIEW (a human decides — never auto-rejected).
 *
 * No React/Next imports; unit-tested. Reuses MIN_RATIO and the shared working-day
 * math. See docs/.../field-day-acceptance spec (phase B).
 */
import { MIN_RATIO } from "./reconcile";
import { addWorkingDays } from "./workdays";

export type VerdictStatus = "ACCEPTED" | "PENDING" | "NEEDS_REVIEW" | "ACCEPTED_EXCEPTION";

export interface VerdictInput {
  flightDate: string;        // YYYY-MM-DD
  airborneMinutes: number;
  videoMinutes: number;
  datasetPosted: boolean;
  today: string;             // YYYY-MM-DD
  graceWorkingDays: number;
}

export interface DayVerdict {
  date: string;
  status: VerdictStatus;
  airborneMinutes: number;
  videoMinutes: number;
  ratio: number | null;
  datasetPosted: boolean;
  withinGrace: boolean;
  reasons: string[];
}

export function verdictForDay(input: VerdictInput): DayVerdict {
  const { flightDate, airborneMinutes, videoMinutes, datasetPosted, today, graceWorkingDays } = input;
  const ratio = airborneMinutes > 0 ? videoMinutes / airborneMinutes : null;
  const videoOk = ratio !== null && ratio >= MIN_RATIO;
  const windowEnd = addWorkingDays(flightDate, graceWorkingDays);
  const withinGrace = today <= windowEnd;

  const reasons: string[] = [];
  if (!videoOk) {
    reasons.push(
      ratio === null
        ? "no airborne time recorded for the day"
        : `video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`,
    );
  }
  if (!datasetPosted) reasons.push("no #datasets notice for the day");

  let status: VerdictStatus;
  if (videoOk && datasetPosted) {
    status = "ACCEPTED";
  } else if (withinGrace) {
    status = "PENDING";
  } else {
    status = "NEEDS_REVIEW";
  }

  return {
    date: flightDate,
    status,
    airborneMinutes,
    videoMinutes,
    ratio,
    datasetPosted,
    withinGrace,
    reasons,
  };
}
