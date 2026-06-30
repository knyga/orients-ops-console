import { describe, expect, it } from "vitest";
import { ROSTER_CORRECTION_TOOL, buildRosterCorrectionPrompt } from "./rosterCorrectionClassifyPrompt";

describe("rosterCorrectionClassifyPrompt", () => {
  it("includes the verdict and the reply", () => {
    const p = buildRosterCorrectionPrompt("✅ 2026-06-13 — прийнято.\n👥 У полі: Андріан.", "насправді були Тарас і Влад");
    expect(p).toContain("Андріан");
    expect(p).toContain("насправді були Тарас і Влад");
  });

  it("exposes the structured tool with kind + crew/eligibility arrays", () => {
    const props = ROSTER_CORRECTION_TOOL.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["kind", "roster", "add", "remove", "counted", "notCounted", "reason"]),
    );
  });
});
