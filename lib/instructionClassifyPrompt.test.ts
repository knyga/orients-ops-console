import { describe, expect, it } from "vitest";
import { CLASSIFY_INSTRUCTION_TOOL, buildInstructionPrompt } from "./instructionClassifyPrompt";

describe("instructionClassifyPrompt", () => {
  it("includes the verdict, the reply, and a pending-proposal echo when present", () => {
    const p = buildInstructionPrompt(
      "⚠️ 2026-06-25 — потрібна перевірка.\n👥 У полі: Влад.",
      "так",
      "Додати Тараса до складу 2026-06-25",
    );
    expect(p).toContain("Влад");
    expect(p).toContain("так");
    expect(p).toContain("Додати Тараса до складу 2026-06-25");
    expect(p).toContain("ОЧІКУЄ ПІДТВЕРДЖЕННЯ");
  });

  it("omits the pending block when there is no active proposal", () => {
    const p = buildInstructionPrompt("verdict", "додай Тараса", null);
    expect(p).not.toContain("ОЧІКУЄ ПІДТВЕРДЖЕННЯ");
  });

  it("exposes a tool covering all axes + confirm/cancel", () => {
    const props = CLASSIFY_INSTRUCTION_TOOL.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "intent",
        "axis",
        "roster",
        "add",
        "remove",
        "counted",
        "notCounted",
        "decision",
        "datasetStatus",
        "videoWaive",
        "airborneMinutes",
        "reason",
      ]),
    );
    const intent = (CLASSIFY_INSTRUCTION_TOOL.input_schema.properties as Record<string, { enum?: string[] }>).intent;
    expect(intent.enum).toEqual(expect.arrayContaining(["confirm", "cancel", "instruction", "unclear"]));
  });
});
