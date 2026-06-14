import type { FlightDay } from "./reconcile";

/** A flight-hours row as edited in the UI (string-typed while being typed). */
export interface FlightHoursRow {
  id: string;
  date: string;
  hours: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `date,flight_hours` CSV into rows. Tolerant of a header line, blank
 * lines, surrounding whitespace, and either comma or semicolon delimiters.
 * Invalid lines are skipped rather than throwing — this is ephemeral input.
 */
export function parseFlightHoursCsv(
  text: string,
  idPrefix = "csv",
): FlightHoursRow[] {
  const rows: FlightHoursRow[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const [rawDate, rawHours] = trimmed.split(/[,;]/).map((c) => c.trim());
    if (!rawDate) return;
    // Skip a header row (non-date first column).
    if (!DATE_RE.test(rawDate)) return;
    if (rawHours === undefined || rawHours === "") return;

    rows.push({ id: `${idPrefix}-${index}`, date: rawDate, hours: rawHours });
  });

  return rows;
}

/**
 * Convert edited rows into validated FlightDay records for reconciliation.
 * Drops rows with an invalid date or non-positive/NaN hours; when a date
 * appears more than once the hours are summed.
 */
export function toFlightDays(rows: FlightHoursRow[]): FlightDay[] {
  const byDate = new Map<string, number>();

  for (const row of rows) {
    const date = row.date.trim();
    const hours = Number(row.hours);
    if (!DATE_RE.test(date) || !Number.isFinite(hours) || hours <= 0) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + hours);
  }

  return [...byDate.entries()]
    .map(([date, flightHours]) => ({ date, flightHours }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
