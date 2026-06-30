import { describe, expect, it } from "vitest";
import { decideRosterCorrection, parseArgs, resolvePeriod, type ClassifiedRosterReply } from "./fieldRosterReport";
import type { RosterCorrectionClassification } from "../lib/rosterCorrectionClassifyPrompt";

const reply = (ts: string, classification: RosterCorrectionClassification): ClassifiedRosterReply => ({
  classification,
  by: "Oleksandr K",
  permalink: "p",
  ts,
});

describe("parseArgs / resolvePeriod", () => {
  it("defaults to the current month and parses --write", () => {
    expect(parseArgs(["--write"]).write).toBe(true);
    expect(resolvePeriod(parseArgs([]), "2026-06-30")).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
});

describe("decideRosterCorrection", () => {
  it("returns null when there is no decisive reply", () => {
    expect(decideRosterCorrection(["Андріан"], [reply("1", { kind: "unclear", reason: "r" })])).toBeNull();
  });

  it("set_roster replaces the crew", () => {
    const out = decideRosterCorrection(["Андріан"], [reply("1", { kind: "set_roster", roster: ["Тарас", "Влад"], reason: "r" })]);
    expect(out?.roster).toEqual(["Тарас", "Влад"]);
  });

  it("patch add/remove and eligibility replay in ts order", () => {
    const out = decideRosterCorrection(["Андріан", "Любомир"], [
      reply("1", { kind: "patch", remove: ["Любомир"], reason: "r" }),
      reply("2", { kind: "patch", add: ["Тарас"], notCounted: ["Андріан"], reason: "r" }),
    ]);
    expect(out?.roster).toEqual(["Андріан", "Тарас"]);
    expect(out?.eligibility).toEqual({ Андріан: "not_counted" });
  });

  it("force-count adds the person to the crew", () => {
    const out = decideRosterCorrection([], [reply("1", { kind: "patch", counted: ["Тарас"], reason: "r" })]);
    expect(out?.roster).toEqual(["Тарас"]);
    expect(out?.eligibility).toEqual({ Тарас: "counted" });
  });

  it("note/by/evidence come from the last decisive reply", () => {
    const out = decideRosterCorrection(["Андріан"], [
      reply("1", { kind: "patch", add: ["Тарас"], reason: "first" }),
      reply("2", { kind: "patch", add: ["Влад"], reason: "last" }),
    ]);
    expect(out?.note).toBe("last");
  });
});
