/**
 * Committed registry of recurring policy obligations, parsed from the
 * operational-policy changelog. Pure — no React/Next/server imports, unit-tested
 * (same discipline as lib/jiraStats.ts).
 *
 * Each obligation says who must post what, in which channel, on what cadence,
 * with how much grace, and over which effective date range. Effective ranges are
 * load-bearing because policies evolve over time.
 *
 * Source of truth: docs/operational-policies-changelog.md. Cadences, responsible
 * parties and effective dates are derived from it; `channel` values are the real
 * Orients channels (lib/slackChannels) where each post actually appears — budget
 * status / inventory statistics in #order_writeoff, drone-remainder and datasets
 * tied to field days in #field-qa / #datasets.
 */
import type { Period } from "./period";

/** How often an obligation comes due. */
export type Cadence =
  | { type: "weekly"; weekday: number } // ISO weekday: 1=Mon … 7=Sun
  | { type: "monthly"; dueDay: number } // due by the Nth day (clamped to month end); match window is 1st → dueDay + grace
  | { type: "per-event" }; // triggered by an external event — not scheduled in v1

export interface Obligation {
  id: string;
  title: string;
  description: string;
  /** Tracked channel name where the fulfilling post is expected (see lib/slackChannels). */
  channel: string;
  responsible: string[];
  cadence: Cadence;
  gracePeriodWorkingDays: number;
  /** Inclusive YYYY-MM-DD; the obligation does not apply before this date. */
  effectiveFrom: string;
  /** Inclusive YYYY-MM-DD; omitted means open-ended. */
  effectiveTo?: string;
  /** Optional recognition hints for the human/AI verdict step. */
  keywords?: string[];
}

export const OBLIGATIONS: Obligation[] = [
  {
    id: "weekly-budget-status",
    title: "Weekly budget status report",
    description:
      "Maryna publishes the weekly budget status every Monday for the prior week.",
    channel: "order_writeoff",
    responsible: ["Maryna"],
    cadence: { type: "weekly", weekday: 1 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-03-03",
    keywords: ["budget", "бюджет", "weekly", "тижневий"],
  },
  {
    id: "monthly-budget-status",
    title: "Monthly budget status report",
    description:
      "Maryna publishes the monthly budget status by the 5th calendar day for the prior month.",
    channel: "order_writeoff",
    responsible: ["Maryna"],
    cadence: { type: "monthly", dueDay: 5 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-03-03",
    keywords: ["budget", "бюджет", "monthly", "місячний"],
  },
  {
    id: "stats-publication",
    title: "Tuesday statistics publication",
    description: "Khrystyna and Maryna publish the statistics every Tuesday.",
    channel: "order_writeoff",
    responsible: ["Khrystyna", "Maryna"],
    cadence: { type: "weekly", weekday: 2 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-02-23",
    keywords: ["stats", "статистик"],
  },
  {
    id: "dynamic-budget-publication",
    title: "Dynamic budget publication",
    description:
      "Maryna publishes the dynamic monthly budgets in the first half of each month (by the 15th).",
    channel: "order_writeoff",
    responsible: ["Maryna"],
    cadence: { type: "monthly", dueDay: 15 },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-05-01",
    keywords: ["budget", "бюджет", "dynamic", "динамічн"],
  },
  {
    id: "drone-remainder-report",
    title: "Drone-remainder report",
    description:
      "Vlad (or delegate) posts the drone-remainder report within 1 working day of a flight day; without it the day's bonuses are not accrued.",
    channel: "field-qa",
    responsible: ["Vlad"],
    cadence: { type: "per-event" },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-04-01",
    keywords: ["drone", "дрон", "remainder", "залишок", "готові"],
  },
  {
    id: "dataset-publication",
    title: "Dataset publication",
    description:
      "Datasets are part of the recording-completeness requirement: published to Google Drive with a notice in #datasets within one working day of the flight day.",
    channel: "datasets",
    responsible: ["Field team"],
    cadence: { type: "per-event" },
    gracePeriodWorkingDays: 1,
    effectiveFrom: "2026-04-01",
    keywords: ["dataset", "датасет"],
  },
];

/**
 * Obligations whose effective range overlaps the period. An obligation applies
 * when it starts on or before the period end AND has no end (or ends on or after
 * the period start). String comparison is valid for YYYY-MM-DD.
 */
export function activeObligations(
  period: Period,
  obligations: Obligation[] = OBLIGATIONS,
): Obligation[] {
  return obligations.filter(
    (o) =>
      o.effectiveFrom <= period.end &&
      (o.effectiveTo === undefined || o.effectiveTo >= period.start),
  );
}
