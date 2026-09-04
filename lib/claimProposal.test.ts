import { describe, it, expect } from "vitest";
import { askClaimToInstruction, claimToInstruction, renderEscalationEcho } from "./claimProposal";

describe("claimToInstruction", () => {
  it("explanation → day/accepted_exception with the pilot's words", () => {
    const r = claimToInstruction({ kind: "explanation", text: "дощ, запис не працював" }, "Тарас");
    expect(r.axis).toBe("day");
    expect(r.instruction.decision).toBe("accepted_exception");
    expect(r.instruction.reason).toBe("за словами Тарас: дощ, запис не працював");
  });
  it("deploy_window → day/accepted_exception noting the window (no deploy override axis in v1)", () => {
    const r = claimToInstruction({ kind: "deploy_window", text: "виїзд 9-15:40", deployWindow: { start: "09:00", end: "15:40" } }, "Влад");
    expect(r.axis).toBe("day");
    expect(r.instruction.reason).toContain("виїзд 09:00–15:40");
  });
  it("airborne → airborne axis", () => {
    const r = claimToInstruction({ kind: "airborne", text: "140 хв", airborneMinutes: 140 }, "Влад");
    expect(r).toMatchObject({ axis: "airborne", instruction: { airborneMinutes: 140 } });
  });
  it("loss_found → loss/found", () => {
    expect(claimToInstruction({ kind: "loss_found", text: "борт знайшли" }, "Влад")).toMatchObject({ axis: "loss", instruction: { lossState: "found" } });
  });
  it("airborne claim without a number degrades to an explanation", () => {
    expect(claimToInstruction({ kind: "airborne", text: "довго літали" }, "Влад").axis).toBe("day");
  });
});

describe("askClaimToInstruction", () => {
  it("maps by gap type: no_dataset → dataset WAIVED, low_video → video waive", () => {
    expect(askClaimToInstruction("no_dataset", { kind: "explanation", text: "не було" }, "Тарас")).toMatchObject({ axis: "dataset", instruction: { datasetStatus: "WAIVED" } });
    expect(askClaimToInstruction("low_video", { kind: "explanation", text: "камера" }, "Тарас")).toMatchObject({ axis: "video", instruction: { videoWaive: true } });
  });
});

describe("renderEscalationEcho", () => {
  it("tags both approvers, quotes the pilot, states the proposal", () => {
    const t = renderEscalationEcho({ byName: "Тарас", claimText: "дощ", summaryUk: "прийняти день 2026-09-01 (виняток)", verifyLine: "відео 48 хв = 40% від 120 хв" });
    expect(t).toContain("<@U08G4EC244X>");
    expect(t).toContain("<@U08G4HZQTTR>");
    expect(t).toContain("Тарас повідомляє: «дощ»");
    expect(t).toContain("Перевірив: відео 48 хв");
    expect(t).toContain("Пропоную: прийняти день 2026-09-01 (виняток)");
    expect(t).toMatch(/«так» \/ «ні»/);
  });
});
