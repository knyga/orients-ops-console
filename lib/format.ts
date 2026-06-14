/** Small presentation helpers shared by the field-ops UI. Pure, client-safe. */

import { FIELD_TIMEZONE } from "./reconcile";

/** Seconds -> minutes, rounded to one decimal (e.g. 90s -> "1.5"). */
export function secondsToMinutes(seconds: number): string {
  return (seconds / 60).toFixed(1);
}

/** Round a minutes value for display (one decimal, trims trailing ".0"). */
export function formatMinutes(minutes: number): string {
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/** Ratio as a percentage string, or an em dash when there is no flight time. */
export function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${Math.round(ratio * 100)}%`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: FIELD_TIMEZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** ISO upload time -> readable Kyiv-local datetime (matches the day-grouping TZ). */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}
