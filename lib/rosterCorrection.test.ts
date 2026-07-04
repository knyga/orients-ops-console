import { describe, expect, it } from "vitest";
import { applyRosterCorrection, correctionForReport, sheetImportShouldSkip, type RosterCorrection } from "./rosterCorrection";

const c = (over: Partial<RosterCorrection>): RosterCorrection => ({
  date: "2026-06-10", note: "n", by: "Oleksandr K", source: "slack", recordedAt: "2026-06-30T00:00:00Z", ...over,
});

describe("sheetImportShouldSkip", () => {
  it("skips a field-ops-sheet write over an existing manual/approver correction", () => {
    expect(sheetImportShouldSkip("manual", "field-ops-sheet")).toBe(true);
    expect(sheetImportShouldSkip("https://slack…/p123", "field-ops-sheet")).toBe(true);
    expect(sheetImportShouldSkip("slack", "field-ops-sheet")).toBe(true);
  });
  it("allows a field-ops-sheet write when none exists or the existing is also a sheet write", () => {
    expect(sheetImportShouldSkip(undefined, "field-ops-sheet")).toBe(false);
    expect(sheetImportShouldSkip("field-ops-sheet", "field-ops-sheet")).toBe(false);
  });
  it("never blocks a non-sheet (approver/manual) write", () => {
    expect(sheetImportShouldSkip("field-ops-sheet", "manual")).toBe(false);
    expect(sheetImportShouldSkip("manual", "slack")).toBe(false);
  });
});

describe("applyRosterCorrection", () => {
  it("passes the parsed roster through when there is no correction", () => {
    const r = applyRosterCorrection(["Андріан", "Любомир"], true);
    expect(r.roster).toEqual(["Андріан", "Любомир"]);
    expect(r.perPerson).toEqual([
      { name: "Андріан", counted: true },
      { name: "Любомир", counted: true },
    ]);
  });

  it("replaces the roster when the correction sets one", () => {
    const r = applyRosterCorrection(["Андріан"], true, c({ roster: ["Тарас", "Влад"] }));
    expect(r.roster).toEqual(["Тарас", "Влад"]);
  });

  it("honours per-person eligibility over the day gate", () => {
    const r = applyRosterCorrection(["Данило", "Тарас"], true, c({ eligibility: { Данило: "not_counted" } }));
    expect(r.perPerson).toEqual([
      { name: "Данило", counted: false },
      { name: "Тарас", counted: true },
    ]);
  });

  it("force-counts a person even when the day gate failed", () => {
    const r = applyRosterCorrection(["Тарас"], false, c({ eligibility: { Тарас: "counted" } }));
    expect(r.perPerson).toEqual([{ name: "Тарас", counted: true }]);
  });
});

describe("correctionForReport", () => {
  it("prefers the exact report-scoped correction, falls back day-wide only on single-report days", () => {
    const dayWide = { date: "2026-07-01", roster: ["Ш"], note: "", by: "b", source: "manual", recordedAt: "t" };
    const scoped = { date: "2026-07-01", reportTs: "2.0", roster: ["С"], note: "", by: "b", source: "slack", recordedAt: "t" };
    expect(correctionForReport([dayWide, scoped], "2026-07-01", "2.0", 2)).toBe(scoped);
    expect(correctionForReport([dayWide], "2026-07-01", "1.0", 2)).toBeUndefined(); // multi-report: Звіт roster wins
    expect(correctionForReport([dayWide], "2026-07-01", "1.0", 1)).toBe(dayWide);
    expect(correctionForReport([dayWide], "2026-07-01", null, 1)).toBe(dayWide);    // synthetic row
  });
});
