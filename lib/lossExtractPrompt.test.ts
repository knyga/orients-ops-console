import { describe, it, expect } from "vitest";
import { LOSS_TOOL, buildLossPrompt } from "./lossExtractPrompt";

describe("loss extract prompt", () => {
  it("requires lost + found booleans", () => {
    expect(LOSS_TOOL.name).toBe("report_loss");
    expect(LOSS_TOOL.input_schema.required).toEqual(expect.arrayContaining(["lost", "found"]));
  });
  it("embeds the report text and asks about found-vs-lost", () => {
    const p = buildLossPrompt("дрон влетів у паркан, знайшли");
    expect(p).toContain("дрон влетів");
    expect(p.toLowerCase()).toContain("found");
  });
});
