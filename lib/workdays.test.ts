import { describe, expect, it } from "vitest";
import { addWorkingDays, isWorkingDay } from "./workdays";

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
});
