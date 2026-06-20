import { describe, expect, it } from "vitest";
import { parsePeriodKey, periodKey } from "./reports";

describe("periodKey", () => {
  it("collapses a single-calendar-month window to YYYY-MM", () => {
    expect(periodKey({ start: "2026-05-01", end: "2026-05-31" })).toBe("2026-05");
    // any window inside one month collapses, even a partial one
    expect(periodKey({ start: "2026-05-03", end: "2026-05-20" })).toBe("2026-05");
  });

  it("keeps both bounds for a cross-month window", () => {
    expect(periodKey({ start: "2026-04-15", end: "2026-05-10" })).toBe(
      "2026-04-15_2026-05-10",
    );
  });
});

describe("parsePeriodKey", () => {
  it("expands a month key to the first..last day of the month", () => {
    expect(parsePeriodKey("2026-05")).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
    // February in a leap year (2028) → 29 days
    expect(parsePeriodKey("2028-02")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });

  it("returns the two bounds of a range key verbatim", () => {
    expect(parsePeriodKey("2026-04-15_2026-05-10")).toEqual({
      start: "2026-04-15",
      end: "2026-05-10",
    });
  });

  it("round-trips with periodKey for a month window", () => {
    const period = parsePeriodKey("2026-05")!;
    expect(periodKey(period)).toBe("2026-05");
  });

  it("returns null for malformed keys", () => {
    expect(parsePeriodKey("nonsense")).toBeNull();
    expect(parsePeriodKey("2026/05")).toBeNull();
    expect(parsePeriodKey("2026-05-01_garbage")).toBeNull();
    expect(parsePeriodKey("")).toBeNull();
  });
});
// writeReport / readReportJson / listPeriods are Postgres-backed IO now — covered
// by the live `db-smoke` script (D2), not unit tests. The pure period helpers stay.
