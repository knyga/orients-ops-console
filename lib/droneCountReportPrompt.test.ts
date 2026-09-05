import { describe, it, expect } from "vitest";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt } from "./droneCountReportPrompt";

describe("droneCountReportPrompt", () => {
  it("exposes a well-formed tool schema", () => {
    expect(DRONE_COUNT_TOOL.name).toBe("record_drone_count_report");
    const schema = DRONE_COUNT_TOOL.input_schema as {
      properties: { reports: { items: { properties: Record<string, unknown>; required: string[] } } };
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["reports", "note"]);
    expect(schema.required).toEqual(["reports", "note"]);
    expect(Object.keys(schema.properties.reports.items.properties)).toEqual(["entries", "forDate"]);
    expect(schema.properties.reports.items.required).toEqual(["entries"]);
  });

  // Regression: one message carried three dated sections (23.06 / 24.06 / 25.06);
  // the old single-forDate schema could only represent one of them, so 06-24's
  // report was silently lost and 06-25 got 06-23's numbers.
  it("teaches that a multi-date message yields one report per dated section", () => {
    const p = buildDroneCountPrompt("x");
    expect(p).toContain("one report per section");
    const reportsDesc = (
      DRONE_COUNT_TOOL.input_schema as { properties: { reports: { description: string } } }
    ).properties.reports.description;
    expect(reportsDesc.toLowerCase()).toContain("dated section");
  });

  it("embeds the day's text and asks for the tool call", () => {
    const p = buildDroneCountPrompt("Демонстраційні - 8 шт (Перевірені - 8шт)");
    expect(p).toContain("Демонстраційні - 8 шт");
    expect(p).toContain("record_drone_count_report");
  });

  // Regression: 'Перевірені - 8шт' inside '(...)' is a status note about the SAME
  // 8 units, not a second 8-drone category — it double-counted every day's total.
  it("teaches that parenthetical qualifiers are not separate entries", () => {
    const p = buildDroneCountPrompt("x");
    expect(p).toContain("Перевірені");
    expect(p.toLowerCase()).toContain("not a separate entry");
    const entriesSchema = (
      DRONE_COUNT_TOOL.input_schema as {
        properties: {
          reports: {
            items: {
              properties: {
                entries: {
                  description: string;
                  items: { properties: { isPerson: { description: string } } };
                };
              };
            };
          };
        };
      }
    ).properties.reports.items.properties.entries;
    expect(entriesSchema.description).toContain("(Перевірені");
    expect(entriesSchema.items.properties.isPerson.description).not.toContain("Перевірені");
  });

  // Regression 2026-08-30: a reminder-thread reply «1 вартовий + 4 вартових
  // ремонт» (no «шт», no name) was classified as "no tally".
  it("frames a reminder-thread reply as the pilot's own tally and counts bare / repair units", () => {
    const p = buildDroneCountPrompt("1 вартовий + 4 вартових ремонт", "2026-08-30", { inReminderThread: true });
    expect(p).toContain("reminder thread");
    expect(p).toContain("1 вартовий + 4 вартових ремонт");
    expect(p).toContain("count:5");
    expect(p).toContain("COUNT them");
    expect(buildDroneCountPrompt("x", "2026-08-30")).not.toContain("reminder thread");
    expect(buildDroneCountPrompt("x", "2026-08-30")).toContain("COUNT them");
  });
});
