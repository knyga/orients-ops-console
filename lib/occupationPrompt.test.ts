import { describe, expect, it } from "vitest";
import { buildOccupationPrompt } from "./occupationPrompt";

describe("buildOccupationPrompt", () => {
  const prompt = buildOccupationPrompt({
    accountId: "u1",
    displayName: "Nadia Khasyshyn",
    tickets: [
      { key: "ATP-1441", summary: "Eval system for models" },
      { key: "ATP-1535", summary: "RayTune hyperparameter tuning" },
    ],
  });

  it("names the person and lists their tickets", () => {
    expect(prompt).toContain("Nadia Khasyshyn");
    expect(prompt).toContain("ATP-1441");
    expect(prompt).toContain("Eval system for models");
    expect(prompt).toContain("ATP-1535");
  });

  it("constrains length to under 200 words", () => {
    expect(prompt).toMatch(/200 words/);
  });
});
