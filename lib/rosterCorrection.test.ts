import { describe, expect, it } from "vitest";
import { applyRosterCorrection, type RosterCorrection } from "./rosterCorrection";

const c = (over: Partial<RosterCorrection>): RosterCorrection => ({
  date: "2026-06-10", note: "n", by: "Oleksandr K", source: "slack", recordedAt: "2026-06-30T00:00:00Z", ...over,
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
