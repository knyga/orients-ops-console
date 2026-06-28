/**
 * Pure derivation of the askable gaps on a NEEDS_REVIEW flight day, and the
 * Ukrainian question the bot would post for each. Only NEEDS_REVIEW days are
 * askable — ACCEPTED/ACCEPTED_EXCEPTION are settled and PENDING is still inside
 * the grace window. No imports beyond the verdict TYPE; unit-tested.
 *
 * Two gap types (from the policy spec):
 *  - no_dataset: no #datasets notice for the day → ask in #datasets.
 *  - low_video:  Vimeo video < 50% of airborne (incl. zero) → ask in #field-qa
 *                (unrecorded flights? tech issue?).
 *
 * Dates in the question text carry their Ukrainian weekday (e.g. "2026-06-23
 * (вівторок)") to match the verdict posts — see dateWithWeekday in ./workdays.
 * The structured `date` field stays a raw YYYY-MM-DD (it's the ask-once key).
 */
import { MIN_RATIO } from "./reconcile";
import { dateWithWeekday } from "./workdays";
import type { DayVerdict } from "./fieldDayVerdict";

export type GapType = "no_dataset" | "low_video";

export interface Gap {
  gapType: GapType;
  date: string;
  /** Tracked channel NAME the question would be posted to. */
  channel: string;
  /** The question text (Ukrainian — the team's language). */
  question: string;
}

/** Stable key per (gapType, date) — the ask-once identity. */
export function gapKey(gapType: GapType, date: string): string {
  return `${gapType}:${date}`;
}

/** The askable gaps for a single day's verdict (empty unless NEEDS_REVIEW). */
export function gapsForDay(day: DayVerdict): Gap[] {
  if (day.status !== "NEEDS_REVIEW") return [];
  const gaps: Gap[] = [];

  const date = dateWithWeekday(day.date);

  const videoOk = day.ratio !== null && day.ratio >= MIN_RATIO;
  if (!videoOk) {
    const vid = day.videoMinutes.toFixed(0);
    const air = day.airborneMinutes.toFixed(0);
    gaps.push({
      gapType: "low_video",
      date: day.date,
      channel: "field-qa",
      question:
        `За ${date} на Vimeo завантажено ${vid} хв відео — це менше 50% від часу в повітрі (${air} хв). ` +
        `Є незаписані польоти, чи була технічна проблема із записом? Якщо так — напишіть деталі.`,
    });
  }

  if (!day.datasetPosted) {
    gaps.push({
      gapType: "no_dataset",
      date: day.date,
      channel: "datasets",
      question:
        `За ${date} не бачу повідомлення про датасет. Його опубліковано? ` +
        `Будь ласка, дайте лінк, або напишіть "немає датасету" якщо публікувати нічого.`,
    });
  }

  return gaps;
}
