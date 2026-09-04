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
  it("crew set + early departure", () => {
    const t = renderProposalSummary("2026-08-05", instr({ axis: "crew", roster: ["Андріан", "Любомир"], early: true }));
    expect(t).toContain("склад 2026-08-05: Андріан, Любомир");
    expect(t).toContain("ранній виїзд");
  });
  it("early denied alone (eligibility axis)", () => {
    expect(renderProposalSummary("2026-08-05", instr({ axis: "eligibility", early: false }))).toContain("без раннього виїзду");
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
  it("renders the loss axis", () => {
    expect(renderProposalSummary("2026-07-04", { intent: "instruction", axis: "loss", lossState: "found", reason: "знайшли" }))
      .toBe("борт 2026-07-04: знайдено (втрату знято)");
    expect(renderProposalSummary("2026-07-04", { intent: "instruction", axis: "loss", lossState: "lost", reason: "не знайшли" }))
      .toBe("борт 2026-07-04: втрачено (не знайдено)");
  });
});
