import { describe, expect, it } from "vitest";
import { CLASSIFY_INSTRUCTION_TOOL, buildInstructionPrompt, classifyInstructionTool } from "./instructionClassifyPrompt";

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

  // «відмінити, немає звіту» on a thread with NO pending proposal must be classifiable
  // only as an instruction (day-reject) or unclear — never a confirm/cancel of a
  // proposal that doesn't exist (2026-07-04: that combination noop'd silently).
  it("narrows the intent enum to instruction/unclear when no proposal is pending", () => {
    const tool = classifyInstructionTool(null);
    const intent = (tool.input_schema.properties as Record<string, { enum?: string[] }>).intent;
    expect(intent.enum).toEqual(["instruction", "unclear"]);
  });

  it("keeps the full intent enum when a proposal is pending", () => {
    const tool = classifyInstructionTool("Відхилити день 2026-06-24");
    const intent = (tool.input_schema.properties as Record<string, { enum?: string[] }>).intent;
    expect(intent.enum).toEqual(["confirm", "cancel", "instruction", "unclear"]);
  });

  it("maps day-annulment wording to a rejection instruction when nothing is pending", () => {
    const p = buildInstructionPrompt("verdict", "відмінити, немає звіту", null);
    expect(p).toContain("НЕМАЄ pending proposal");
    expect(p).toContain("«відмінити»");
    expect(p).toContain('decision="rejected"');
  });

  it("the tool schema carries the loss axis + lossState", () => {
    const schema = CLASSIFY_INSTRUCTION_TOOL.input_schema as {
      properties: { axis: { enum: string[] }; lossState: { enum: string[] } };
    };
    expect(schema.properties.axis.enum).toContain("loss");
    expect(schema.properties.lossState.enum).toEqual(["found", "lost"]);
  });

  it("the prompt guides the loss axis", () => {
    const p = buildInstructionPrompt("verdict", "борт знайшли", null);
    expect(p).toContain('axis="loss"');
    expect(p).toContain('lossState="found"');
  });
});
