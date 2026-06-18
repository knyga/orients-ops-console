import { describe, expect, it } from "vitest";
import type { SlackMessage } from "./policySchedule";
import { buildExtractionPrompt, FLIGHT_HOURS_TOOL } from "./flightExtractPrompt";

function msg(ts: string, text: string): SlackMessage {
  return {
    channel: "field-qa",
    authorId: "U1",
    author: "Pilot",
    ts,
    isoTime: new Date(Number(ts) * 1000).toISOString(),
    text,
    permalink: "",
  };
}

describe("FLIGHT_HOURS_TOOL", () => {
  it("forces a days array with the required per-day fields", () => {
    expect(FLIGHT_HOURS_TOOL.name).toBe("report_flight_hours");
    const schema = FLIGHT_HOURS_TOOL.input_schema as {
      properties: { days: { type: string; items: { required: string[] } } };
    };
    expect(schema.properties.days.type).toBe("array");
    expect(schema.properties.days.items.required).toEqual(
      expect.arrayContaining(["date", "flightHours", "windows", "crew", "sourceTs"]),
    );
  });
});

describe("buildExtractionPrompt", () => {
  it("includes the rules and every message with its ts", () => {
    const prompt = buildExtractionPrompt([
      msg("1781798204.640689", "Звіт 18.06.2026\nА+Д 15:20-18:30"),
      msg("1781726409.890369", "Статистика польотів за 2026-06-17"),
    ]);
    expect(prompt).toContain("Звіт");
    expect(prompt).toContain("15:20-18:30");
    expect(prompt).toContain("1781798204.640689");
    expect(prompt).toMatch(/DD\.MM\.YYYY/);
    expect(prompt).toContain("report_flight_hours");
  });
});
