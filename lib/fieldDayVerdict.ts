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

export type VerdictStatus = "ACCEPTED" | "PENDING" | "NEEDS_REVIEW" | "ACCEPTED_EXCEPTION" | "REJECTED";

/** The dataset axis outcome for a flight day (see the dataset-acceptance spec). */
export type DatasetStatus = "POSTED" | "WAIVED" | "MISSING" | "DECLINED";

export interface VerdictInput {
  flightDate: string;        // YYYY-MM-DD
  airborneMinutes: number;
  videoMinutes: number;
  datasetStatus: DatasetStatus;
  today: string;             // YYYY-MM-DD
  graceWorkingDays: number;
}

export interface DayVerdict {
  date: string;
  status: VerdictStatus;
  airborneMinutes: number;
  videoMinutes: number;
  ratio: number | null;
  datasetStatus: DatasetStatus;
  withinGrace: boolean;
  reasons: string[];
  /** Resolved crew names for the day (display/attribution; not part of the gate). */
  roster: string[];
  /** "Звіт" tokens that did not resolve to a name (internal surfaces only). */
  unknownInitials: string[];
}

export function verdictForDay(input: VerdictInput): DayVerdict {
  const { flightDate, airborneMinutes, videoMinutes, datasetStatus, today, graceWorkingDays } = input;
  const ratio = airborneMinutes > 0 ? videoMinutes / airborneMinutes : null;
  const videoOk = ratio !== null && ratio >= MIN_RATIO;
  const datasetOk = datasetStatus === "POSTED" || datasetStatus === "WAIVED";
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
  if (datasetStatus === "MISSING") reasons.push("no #datasets notice for the day");
  if (datasetStatus === "WAIVED") reasons.push("no dataset — reason accepted (waived)");
  if (datasetStatus === "DECLINED") reasons.push("dataset reason declined by an admin");

  let status: VerdictStatus;
  if (datasetStatus === "DECLINED") {
    status = "REJECTED";
  } else if (videoOk && datasetOk) {
    status = "ACCEPTED";
  } else if (withinGrace) {
    status = "PENDING";
  } else {
    status = "NEEDS_REVIEW";
  }

  return { date: flightDate, status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace, reasons, roster: [], unknownInitials: [] };
}
