import { describe, expect, it } from "vitest";
import { AIRBORNE_TOOL, buildVisionPrompt } from "./flightExtractPrompt";

describe("AIRBORNE_TOOL", () => {
  it("requires flew, airborneSeconds and flights", () => {
    expect(AIRBORNE_TOOL.name).toBe("report_airborne");
    const schema = AIRBORNE_TOOL.input_schema as { required: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(["flew", "airborneSeconds", "flights"]),
    );
  });
});

describe("buildVisionPrompt", () => {
  it("names the airborne field and the no-fly case", () => {
    const p = buildVisionPrompt();
    expect(p).toContain("Час в повітрі");
    expect(p).toContain("report_airborne");
    expect(p).toMatch(/Ні|did not fly|no flight/i);
  });
});
