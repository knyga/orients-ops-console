import { describe, expect, it } from "vitest";
import { buildRosterOutcome } from "./instructionOutcome";
import { parseRosterSuffix } from "./verdictPublish";
import type { InstructionClassification } from "./instructionClassifyPrompt";

const instr = (o: Partial<InstructionClassification>): InstructionClassification => ({
  intent: "instruction",
  reason: "r",
  ...o,
});

describe("parseRosterSuffix", () => {
  it("parses crew names from the crew suffix", () => {
    expect(parseRosterSuffix("⚠️ 2026-06-25 …\n👥 У полі: Влад, Тарас.")).toEqual(["Влад", "Тарас"]);
  });
  it("returns [] when there is no crew suffix", () => {
    expect(parseRosterSuffix("no suffix here")).toEqual([]);
  });
});

describe("buildRosterOutcome", () => {
  it("patch add preserves the existing crew (empty-baseline bug fix)", () => {
    const out = buildRosterOutcome(["Влад"], instr({ axis: "crew", add: ["Тарас"] }), "Oleksandr K", "url");
    expect(out.roster).toEqual(["Влад", "Тарас"]);
    expect(out.by).toBe("Oleksandr K");
    expect(out.evidencePermalink).toBe("url");
  });

  it("set_roster replaces the crew entirely", () => {
    const out = buildRosterOutcome(["Влад"], instr({ axis: "crew", roster: ["Андріан", "Надія"] }), "x", "");
    expect(out.roster).toEqual(["Андріан", "Надія"]);
  });

  it("remove drops a person from the baseline", () => {
    const out = buildRosterOutcome(["Влад", "Тарас"], instr({ axis: "crew", remove: ["Влад"] }), "x", "");
    expect(out.roster).toEqual(["Тарас"]);
  });

  it("notCounted keeps the person on the crew but flags eligibility", () => {
    const out = buildRosterOutcome(["Влад", "Данило"], instr({ axis: "eligibility", notCounted: ["Данило"] }), "x", "");
    expect(out.roster).toEqual(["Влад", "Данило"]);
    expect(out.eligibility).toEqual({ Данило: "not_counted" });
  });

  it("counted adds the person if absent and flags eligibility", () => {
    const out = buildRosterOutcome(["Влад"], instr({ axis: "eligibility", counted: ["Тарас"] }), "x", "");
    expect(out.roster).toEqual(["Влад", "Тарас"]);
    expect(out.eligibility).toEqual({ Тарас: "counted" });
  });
});
