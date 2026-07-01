import { describe, it, expect } from "vitest";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt } from "./droneCountReportPrompt";

describe("droneCountReportPrompt", () => {
  it("exposes a well-formed tool schema", () => {
    expect(DRONE_COUNT_TOOL.name).toBe("record_drone_count_report");
    const schema = DRONE_COUNT_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["present", "note"]);
    expect(schema.required).toEqual(["present", "note"]);
  });

  it("embeds the day's text and asks for the tool call", () => {
    const p = buildDroneCountPrompt("Демонстраційні - 8 шт (Перевірені - 8шт)");
    expect(p).toContain("Демонстраційні - 8 шт");
    expect(p).toContain("record_drone_count_report");
  });
});
