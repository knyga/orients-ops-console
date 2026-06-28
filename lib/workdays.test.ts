import { describe, expect, it } from "vitest";
import { addWorkingDays, dateWithWeekday, isWorkingDay, ukrainianWeekday } from "./workdays";

describe("workdays", () => {
  it("isWorkingDay treats Sat/Sun as non-working", () => {
    expect(isWorkingDay("2026-05-04")).toBe(true); // Monday
    expect(isWorkingDay("2026-05-09")).toBe(false); // Saturday
    expect(isWorkingDay("2026-05-10")).toBe(false); // Sunday
  });

  it("addWorkingDays skips the weekend", () => {
    expect(addWorkingDays("2026-05-08", 1)).toBe("2026-05-11"); // Fri +1wd → Mon
    expect(addWorkingDays("2026-05-04", 0)).toBe("2026-05-04");
    expect(addWorkingDays("2026-06-18", 3)).toBe("2026-06-23"); // Thu +3wd → Tue
  });

  it("ukrainianWeekday names each day in the nominative", () => {
    expect(ukrainianWeekday("2026-06-22")).toBe("понеділок"); // Mon
    expect(ukrainianWeekday("2026-06-23")).toBe("вівторок"); // Tue
    expect(ukrainianWeekday("2026-06-24")).toBe("середа"); // Wed
    expect(ukrainianWeekday("2026-06-25")).toBe("четвер"); // Thu
    expect(ukrainianWeekday("2026-06-26")).toBe("п'ятниця"); // Fri
    expect(ukrainianWeekday("2026-06-27")).toBe("субота"); // Sat
    expect(ukrainianWeekday("2026-06-28")).toBe("неділя"); // Sun
  });

  it("dateWithWeekday appends the Ukrainian weekday in parentheses", () => {
    expect(dateWithWeekday("2026-06-23")).toBe("2026-06-23 (вівторок)");
  });
});
