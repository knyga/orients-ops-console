/**
 * Pure period-key helpers shared by the CLIs, the API routes, AND client
 * components. Kept free of `node:fs` (unlike ../lib/reports, which imports it)
 * so a `"use client"` file can import `periodKey`/`parsePeriodKey` without
 * dragging Node built-ins into the browser bundle.
 */
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY = "\\d{4}-\\d{2}-\\d{2}";
const RANGE_RE = new RegExp(`^(${DAY})_(${DAY})$`);

export interface Period {
  start: string;
  end: string;
}

/**
 * Canonical period key shared by every feature and used as the `?period=` URL
 * value. A window inside one calendar month collapses to `YYYY-MM` (the common
 * monthly cadence); anything spanning months keeps both explicit bounds as
 * `YYYY-MM-DD_YYYY-MM-DD`.
 */
export function periodKey(period: Period): string {
  if (period.start.slice(0, 7) === period.end.slice(0, 7)) {
    return period.start.slice(0, 7);
  }
  return `${period.start}_${period.end}`;
}

/**
 * Inverse of `periodKey`. A `YYYY-MM` key expands to the first..last day of that
 * month; a range key returns its two bounds verbatim. Returns null for anything
 * malformed so callers (API routes) can answer 400.
 */
export function parsePeriodKey(key: string): Period | null {
  if (MONTH_RE.test(key)) {
    const [year, month] = key.split("-").map(Number);
    // Day 0 of the next month is the last day of this one (UTC, no DST drift).
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, "0")}` };
  }
  const range = RANGE_RE.exec(key);
  if (range) {
    return { start: range[1], end: range[2] };
  }
  return null;
}
