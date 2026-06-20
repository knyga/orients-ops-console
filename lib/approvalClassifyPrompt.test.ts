import { describe, expect, it } from "vitest";
import { APPROVAL_TOOL, buildApprovalPrompt } from "./approvalClassifyPrompt";

describe("APPROVAL_TOOL schema", () => {
  it("requires decision/reason and constrains the decision to three cases", () => {
    expect(APPROVAL_TOOL.name).toBe("classify_approval");
    const props = APPROVAL_TOOL.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(APPROVAL_TOOL.input_schema.required).toEqual(["decision", "reason"]);
    expect(props.decision.enum).toEqual(["approve", "disapprove", "unclear"]);
  });
});

describe("buildApprovalPrompt", () => {
  it("embeds the verdict message and the approver reply verbatim", () => {
    const p = buildApprovalPrompt(
      "⚠️ 2026-06-04 — needs review: no #datasets notice",
      "все ок, ми тестували інше — датасет не потрібен",
    );
    expect(p).toContain("⚠️ 2026-06-04 — needs review");
    expect(p).toContain("ми тестували інше");
    expect(p).toMatch(/classify_approval/);
    expect(p).toMatch(/Return only the tool call/);
  });
});
