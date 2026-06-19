import { describe, expect, it } from "vitest";
import { ANSWER_TOOL, buildClassifyPrompt } from "./answerClassifyPrompt";

describe("ANSWER_TOOL schema", () => {
  it("requires resolved/type/note and constrains type to the four cases", () => {
    expect(ANSWER_TOOL.name).toBe("classify_answer");
    const props = ANSWER_TOOL.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(ANSWER_TOOL.input_schema.required).toEqual(["resolved", "type", "note"]);
    expect(props.type.enum).toEqual(["accepted_exception", "data_provided", "still_missing", "unclear"]);
  });
});

describe("buildClassifyPrompt", () => {
  it("embeds the question and reply verbatim", () => {
    const p = buildClassifyPrompt("За 2026-06-13 не бачу датасету.", "погода була жахлива, не літали нормально");
    expect(p).toContain("За 2026-06-13 не бачу датасету.");
    expect(p).toContain("погода була жахлива");
    expect(p).toMatch(/accepted_exception/);
    expect(p).toMatch(/Return only the tool call/);
  });
});
