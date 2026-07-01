import { describe, it, expect } from "vitest";
import { windowMonths, CATCHUP_BOUNDARY_DAYS } from "./nightlyWindow";

describe("windowMonths", () => {
  it("mid-month returns only the current month up to today", () => {
    expect(windowMonths("2026-07-15")).toEqual([{ start: "2026-07-01", end: "2026-07-15" }]);
  });

  it("within the boundary also returns the full previous month, oldest first", () => {
    expect(windowMonths("2026-07-01")).toEqual([
      { start: "2026-06-01", end: "2026-06-30" },
      { start: "2026-07-01", end: "2026-07-01" },
    ]);
  });

  it("handles the January -> December year rollback", () => {
    expect(windowMonths("2026-01-03")).toEqual([
      { start: "2025-12-01", end: "2025-12-31" },
      { start: "2026-01-01", end: "2026-01-03" },
    ]);
  });

  it("respects the day exactly on the boundary and excludes the day after", () => {
    expect(windowMonths("2026-07-05")).toHaveLength(2);
    expect(windowMonths("2026-07-06")).toHaveLength(1);
  });

  it("exposes the default boundary constant", () => {
    expect(CATCHUP_BOUNDARY_DAYS).toBe(5);
  });
});
