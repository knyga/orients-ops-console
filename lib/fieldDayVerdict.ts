/**
 * Pure per-flight-day acceptance verdict for the field bonus. Operationalizes the
 * unified day-qualification gate: a day is ACCEPTED when every gate axis passes.
 * The gate has per-report axes (deployment >= 3h, crew), day-shared axes (video >= max(2 min, 50% x airborne),
 * a #field-qa drone-count report, and a #datasets notice). Three failures are
 * machine auto-rejects (hard no-pay, admin can override via the instruction
 * path): an admin-declined dataset, a deployment under 3h, and a missing
 * drone-count report. Curable gaps stay PENDING inside the grace window and
 * NEEDS_REVIEW after. ACCEPTED ⇔ the crew is paid for the day (see the
 * 2026-07-03 unified-day-qualification spec).
 *
 * No React/Next imports; unit-tested. Reuses MIN_RATIO and the shared working-day
 * math. See docs/.../field-day-acceptance spec (phase B).
 */
import { MIN_RATIO } from "./reconcile";
import { addWorkingDays } from "./workdays";
import type { DroneEntry } from "./droneReport";

export const MIN_DEPLOY_MIN = 180;
export const MIN_VIDEO_MIN = 2;

/** Canonical store key for one report's verdict: "<date>#<reportTs>"; the bare
 *  date for a synthetic no-Звіт row — and for every legacy pre-multi-report row. */
export function reportKey(date: string, reportTs: string | null | undefined): string {
  return reportTs ? `${date}#${reportTs}` : date;
}

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
  /** false when the day was surfaced from a "Звіт" that reported no airborne time. Defaults true. */
  airborneReported?: boolean;
  /** Reported deployment window, when known (for the honest message). */
  deployWindow?: { start: string; end: string };
  /** Звіт deployment minutes: number → gate on it; null → Звіт without a window (curable gap); undefined → unknown source (don't gate). */
  deployMin?: number | null;
  /** false when no drone-count report was attributed to this flight day. Defaults true (unknown → don't gate). */
  droneReportPresent?: boolean;
  /** false when the day has no parsed "Звіт" at all (nobody attributable to pay). Defaults true. */
  hasZvit?: boolean;
  /** Звіт message ts — the report's identity; null/absent = synthetic no-Звіт day. */
  reportTs?: string | null;
  /** 1-based position among the day's reports (display: «виїзд 2/2»). */
  reportSeq?: number;
  reportCount?: number;
}

export interface DayVerdict {
  date: string;
  /** Звіт message ts; null = no-Звіт synthetic row or a legacy day verdict. */
  reportTs: string | null;
  reportSeq: number;
  reportCount: number;
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
  /** false when the day was surfaced from a "Звіт" with no airborne figure. */
  airborneReported: boolean;
  /** Reported deployment window, when known. */
  deployWindow?: { start: string; end: string };
  /** Звіт deployment minutes (gate axis); absent on legacy reports. */
  deployMin?: number | null;
  /** false when no drone-count report was attributed to the day; absent = ungated. */
  droneReportPresent?: boolean;
  /** false when the day has no parsed "Звіт"; absent = true. */
  hasZvit?: boolean;
  /** Per-person / per-category drone counts for the day (display only; not a gate). */
  droneReport?: DroneEntry[];
  /** Drone-loss state for THIS report (from the loss ledger); absent = no loss. */
  loss?: { lost: boolean; found: boolean };
}

export function verdictForDay(input: VerdictInput): DayVerdict {
  const { flightDate, airborneMinutes, videoMinutes, datasetStatus, today, graceWorkingDays } = input;
  const airborneReported = input.airborneReported ?? true;
  const droneReportPresent = input.droneReportPresent ?? true;
  const hasZvit = input.hasZvit ?? true;
  const deployMin = input.deployMin;
  const ratio = airborneMinutes > 0 ? videoMinutes / airborneMinutes : null;
  const videoOk = ratio !== null && ratio >= MIN_RATIO && videoMinutes >= MIN_VIDEO_MIN;
  const datasetOk = datasetStatus === "POSTED" || datasetStatus === "WAIVED";
  const windowEnd = addWorkingDays(flightDate, graceWorkingDays);
  const withinGrace = today <= windowEnd;
  // Deploy/drone/Звіт axes only bind when the day actually flew — a no-fly day
  // has no pay at stake and stays on the review path.
  const flew = airborneMinutes > 0 || !airborneReported;
  const deployShort = flew && typeof deployMin === "number" && deployMin < MIN_DEPLOY_MIN; // hard fail
  const deployUnknown = flew && deployMin === null;                                        // curable gap
  const droneMissing = flew && !droneReportPresent;                                        // hard fail
  const noZvit = flew && !hasZvit;                                                         // curable gap

  const reasons: string[] = [];
  if (!videoOk) {
    if (ratio === null) {
      reasons.push(
        airborneReported
          ? "drones did not fly (0 flights, 0 min airborne)"
          : "flight reported but airborne time not recorded",
      );
    } else if (ratio < MIN_RATIO) {
      reasons.push(`video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`);
    } else {
      reasons.push(`video ${videoMinutes.toFixed(1)}m is under the ${MIN_VIDEO_MIN}-minute floor`);
    }
  }
  if (deployShort) reasons.push(`deployment ${deployMin}m is under 3h`);
  if (deployUnknown) reasons.push("deployment window not recorded in the Звіт");
  if (droneMissing) reasons.push("no drone-count report in #field-qa");
  if (noZvit) reasons.push("flight detected but no Звіт (crew/deployment unknown)");
  if (datasetStatus === "MISSING") reasons.push("no #datasets notice for the day");
  if (datasetStatus === "WAIVED") reasons.push("no dataset — reason accepted (waived)");
  if (datasetStatus === "DECLINED") reasons.push("dataset reason declined by an admin");

  let status: VerdictStatus;
  if (datasetStatus === "DECLINED" || deployShort || droneMissing) {
    status = "REJECTED";
  } else if (videoOk && datasetOk && !deployUnknown && !noZvit) {
    status = "ACCEPTED";
  } else if (withinGrace) {
    status = "PENDING";
  } else {
    status = "NEEDS_REVIEW";
  }

  return {
    date: flightDate,
    reportTs: input.reportTs ?? null,
    reportSeq: input.reportSeq ?? 1,
    reportCount: input.reportCount ?? 1,
    status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace,
    reasons, roster: [], unknownInitials: [], airborneReported, deployWindow: input.deployWindow,
    deployMin, droneReportPresent, hasZvit,
  };
}
