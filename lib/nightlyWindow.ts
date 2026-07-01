/**
 * Pure catch-up window for the nightly field pipeline. The nightly run always
 * covers the current Kyiv month; within the first few days of a new month it
 * ALSO covers the whole previous month, so settled-but-unpublished days from the
 * prior month are still swept up after the boundary rolls over (otherwise a
 * current-month-only run would strand them forever). No imports — unit-tested.
 */
export interface WindowMonth {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

/** Days into a new month during which the previous month stays in the window. */
export const CATCHUP_BOUNDARY_DAYS = 5;

/** Last calendar day (YYYY-MM-DD) of the month `month1to12` in `year`. */
function lastDayOfMonth(year: number, month1to12: number): string {
  // Day 0 of the next month === last day of this month. Handles leap years.
  const d = new Date(Date.UTC(year, month1to12, 0));
  const mm = String(month1to12).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function windowMonths(today: string, boundaryDays: number = CATCHUP_BOUNDARY_DAYS): WindowMonth[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)); // 1..12
  const day = Number(today.slice(8, 10));

  const current: WindowMonth = { start: `${today.slice(0, 7)}-01`, end: today };

  if (day > boundaryDays) return [current];

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const pm = String(prevMonth).padStart(2, "0");
  const previous: WindowMonth = {
    start: `${prevYear}-${pm}-01`,
    end: lastDayOfMonth(prevYear, prevMonth),
  };
  return [previous, current];
}
