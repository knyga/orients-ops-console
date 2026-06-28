import { describe, it, expect } from "vitest";
import { parseArgs, resolvePeriod, toCsv } from "./fieldBonusReport";
import type { BonusReport } from "../lib/fieldBonus";

const report: BonusReport = {
  period: { start: "2026-05-01", end: "2026-05-31" }, days: [], penalties: [], teamZeroed: false, flags: [], total: 700,
  people: [{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }],
};

describe("fieldBonusReport", () => {
  it("parses flags", () => {
    expect(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--write", "--format", "table"]))
      .toMatchObject({ start: "2026-05-01", end: "2026-05-31", write: true, format: "table" });
  });
  it("defaults the period to the current Kyiv month", () => {
    expect(resolvePeriod({ write: false, ask: false, publish: false }, "2026-05-17")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });
  it("emits a per-person CSV header + rows", () => {
    expect(toCsv(report).split("\n")[0]).toBe("person,trips,early,weekend,gross,penaltyPct,net");
    expect(toCsv(report)).toContain("Андріан,1,0,0,700,0,700");
  });
});
