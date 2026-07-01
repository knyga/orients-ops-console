import { describe, expect, it } from "vitest";
import { renderProposalSummary } from "./proposalSummary";
import type { InstructionClassification } from "./instructionClassifyPrompt";

const instr = (o: Partial<InstructionClassification>): InstructionClassification => ({
  intent: "instruction",
  reason: "r",
  ...o,
});

describe("renderProposalSummary", () => {
  it("crew add", () => {
    expect(renderProposalSummary("2026-06-25", instr({ axis: "crew", add: ["Тарас"] }))).toContain("додати");
    expect(renderProposalSummary("2026-06-25", instr({ axis: "crew", add: ["Тарас"] }))).toContain("Тарас");
  });
  it("crew set (roster)", () => {
    expect(renderProposalSummary("2026-06-25", instr({ axis: "crew", roster: ["Влад", "Тарас"] }))).toContain("склад");
  });
  it("day accept", () => {
    expect(renderProposalSummary("2026-06-21", instr({ axis: "day", decision: "accepted_exception" }))).toContain("прийняти день");
  });
  it("day reject", () => {
    expect(renderProposalSummary("2026-06-21", instr({ axis: "day", decision: "rejected" }))).toContain("відхилити день");
  });
  it("airborne minutes", () => {
    const s = renderProposalSummary("2026-06-21", instr({ axis: "airborne", airborneMinutes: 0 }));
    expect(s).toContain("час у повітрі");
    expect(s).toContain("0");
  });
  it("always names the date", () => {
    expect(renderProposalSummary("2026-06-25", instr({ axis: "crew", add: ["Тарас"] }))).toContain("2026-06-25");
  });
});
