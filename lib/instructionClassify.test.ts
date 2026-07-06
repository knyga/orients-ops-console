import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { classifyInstruction } from "./instructionClassify";

function toolUse(input: unknown) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "classify_instruction", input }],
  };
}

describe("classifyInstruction", () => {
  beforeEach(() => {
    create.mockReset();
    process.env.ANTHROPIC_API_KEY = "test";
  });

  // Regression: the "loss" axis (drone found/lost) was added to the prompt/schema
  // but the deterministic backstop's VALID_AXIS list and the returned object never
  // picked it up, so a real approver reply («борт знайшли») classified fine upstream
  // but silently lost both axis and lossState on the way out — a no-op downstream.
  it("passes axis=loss and lossState through intact", async () => {
    create.mockResolvedValue(
      toolUse({ intent: "instruction", axis: "loss", lossState: "found", reason: "знайшли борт" }),
    );
    const r = await classifyInstruction("verdict text", "борт знайшли", null);
    expect(r.intent).toBe("instruction");
    expect(r.axis).toBe("loss");
    expect(r.lossState).toBe("found");
    expect(r.reason).toBe("знайшли борт");
  });

  it("drops an invalid lossState but keeps the axis", async () => {
    create.mockResolvedValue(
      toolUse({ intent: "instruction", axis: "loss", lossState: "maybe", reason: "not sure" }),
    );
    const r = await classifyInstruction("verdict text", "хтозна", null);
    expect(r.axis).toBe("loss");
    expect(r.lossState).toBeUndefined();
  });
});
