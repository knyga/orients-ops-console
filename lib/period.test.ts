import { describe, expect, it } from "vitest";
import { monthsCovering } from "./period";

describe("monthsCovering", () => {
  it("a single-month period returns one full month", () => {
    expect(monthsCovering({ start: "2026-09-01", end: "2026-09-04" })).toEqual([
      { start: "2026-09-01", end: "2026-09-30" },
    ]);
  });

  it("a cross-month period returns each touched month, full, in order", () => {
    expect(monthsCovering({ start: "2026-08-20", end: "2026-09-04" })).toEqual([
      { start: "2026-08-01", end: "2026-08-31" },
      { start: "2026-09-01", end: "2026-09-30" },
    ]);
  });

  it("a range spanning a year boundary returns two months in order", () => {
    expect(monthsCovering({ start: "2026-12-15", end: "2027-01-10" })).toEqual([
      { start: "2026-12-01", end: "2026-12-31" },
      { start: "2027-01-01", end: "2027-01-31" },
    ]);
  });

  it("start === end returns that one month", () => {
    expect(monthsCovering({ start: "2026-09-03", end: "2026-09-03" })).toEqual([
      { start: "2026-09-01", end: "2026-09-30" },
    ]);
  });
});
