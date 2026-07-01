import { describe, expect, it } from "vitest";
import { buildManualInstruction, filterEntriesToWindow, parseArgs } from "./fieldInstructionsReport";

describe("filterEntriesToWindow", () => {
  const entries = [
    { date: "2026-06-19" },
    { date: "2026-06-25" },
    { date: "2026-06-30" },
  ];
  it("keeps only entries whose date is within [start, end]", () => {
    expect(filterEntriesToWindow(entries, "2026-06-25", "2026-06-25").map((e) => e.date)).toEqual(["2026-06-25"]);
  });
  it("is inclusive on both bounds", () => {
    expect(filterEntriesToWindow(entries, "2026-06-19", "2026-06-30").map((e) => e.date)).toEqual([
      "2026-06-19",
      "2026-06-25",
      "2026-06-30",
    ]);
  });
});

describe("buildManualInstruction", () => {
  it("--set-crew → crew set_roster", () => {
    const r = buildManualInstruction({ setCrew: ["Влад", "Тарас"], reason: "" });
    expect(r?.axis).toBe("crew");
    expect(r?.instruction.roster).toEqual(["Влад", "Тарас"]);
  });
  it("--add-crew → crew add", () => {
    expect(buildManualInstruction({ addCrew: ["Тарас"], reason: "" })?.instruction.add).toEqual(["Тарас"]);
  });
  it("--airborne → airborne minutes", () => {
    const r = buildManualInstruction({ airborne: 0, reason: "" });
    expect(r?.axis).toBe("airborne");
    expect(r?.instruction.airborneMinutes).toBe(0);
  });
  it("--reject → day rejected", () => {
    const r = buildManualInstruction({ reject: true, reason: "" });
    expect(r?.axis).toBe("day");
    expect(r?.instruction.decision).toBe("rejected");
  });
  it("--accept → day accepted_exception", () => {
    expect(buildManualInstruction({ accept: true, reason: "" })?.instruction.decision).toBe("accepted_exception");
  });
  it("nothing actionable → null", () => {
    expect(buildManualInstruction({ reason: "" })).toBeNull();
  });
});

describe("parseArgs", () => {
  it("parses a manual crew set with comma-split names", () => {
    const a = parseArgs(["--date", "2026-06-25", "--set-crew", "Влад,Тарас", "--by", "Oleksandr K", "--write"]);
    expect(a.date).toBe("2026-06-25");
    expect(a.setCrew).toEqual(["Влад", "Тарас"]);
    expect(a.by).toBe("Oleksandr K");
    expect(a.write).toBe(true);
  });
  it("defaults to dry-run sweep", () => {
    const a = parseArgs([]);
    expect(a.write).toBe(false);
    expect(a.date).toBeUndefined();
  });
});
