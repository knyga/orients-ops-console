/**
 * Pure working-day calendar math (Mon–Fri; public holidays not modeled), shared
 * by the policy scheduler and the field-day verdict. All dates are YYYY-MM-DD in
 * UTC — consistent with the rest of the repo's calendar math. No imports.
 */
function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fmtDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1=Mon … 7=Sun. */
export function isoWeekday(day: string): number {
  const dow = parseDay(day).getUTCDay(); // 0=Sun … 6=Sat
  return dow === 0 ? 7 : dow;
}

export function isWorkingDay(day: string): boolean {
  const wd = isoWeekday(day);
  return wd >= 1 && wd <= 5;
}

/** Add `n` working days (Mon–Fri) to a YYYY-MM-DD date; n=0 returns the input. */
export function addWorkingDays(day: string, n: number): string {
  const date = parseDay(day);
  let added = 0;
  while (added < n) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkingDay(fmtDay(date))) added += 1;
  }
  return fmtDay(date);
}
