import { describe, expect, it } from "vitest";
import type { ExtractedDay } from "../lib/flightExtractPrompt";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toInputsCsv,
  validateDays,
} from "./fieldQaReport";

function day(date: string, flightHours: number, extra: Partial<ExtractedDay> = {}): ExtractedDay {
  return { date, flightHours, windows: [], crew: null, sourceTs: "1.0", ...extra };
}

describe("parseArgs", () => {
  it("reads bounds, format and --write", () => {
    expect(
      parseArgs(["--start", "2026-06-01", "--end", "2026-06-18", "--format", "table", "--write"]),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", format: "table", write: true });
  });
  it("defaults format json and write false", () => {
    expect(parseArgs([])).toEqual({ start: undefined, end: undefined, format: "json", write: false });
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when both present", () => {
    expect(
      resolvePeriod({ format: "json", write: false, start: "2026-06-01", end: "2026-06-18" }, "2026-06-18"),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", timezone: "Europe/Kyiv" });
  });
  it("falls back to the current month when a bound is missing", () => {
    expect(
      resolvePeriod({ format: "json", write: false, start: "2026-06-01" }, "2026-06-18"),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", timezone: "Europe/Kyiv" });
  });
  it("throws on a malformed date", () => {
    expect(() =>
      resolvePeriod({ format: "json", write: false, start: "06/01", end: "2026-06-18" }, "2026-06-18"),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("validateDays", () => {
  it("drops invalid rows, sums duplicate dates, sorts ascending", () => {
    const result = validateDays([
      day("2026-06-02", 2),
      day("2026-06-01", 1.5, { windows: [{ start: "10:00", end: "11:30" }], crew: "А+Д", sourceTs: "100.1" }),
      day("2026-06-01", 0.5, { windows: [{ start: "14:00", end: "14:30" }], sourceTs: "100.9" }),
      day("bad-date", 3),
      day("2026-06-03", 0),
      day("2026-06-04", Number.NaN),
    ]);
    expect(result.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02"]);
    const first = result[0];
    expect(first.flightHours).toBe(2); // 1.5 + 0.5
    expect(first.windows).toHaveLength(2); // merged
    expect(first.crew).toBe("А+Д");
    expect(first.sourceTs).toBe("100.1");
  });
});

describe("toInputsCsv", () => {
  it("emits the fieldops date,flight_hours contract", () => {
    const csv = toInputsCsv(validateDays([day("2026-06-01", 3.17), day("2026-06-02", 4)]));
    expect(csv).toBe("date,flight_hours\n2026-06-01,3.17\n2026-06-02,4\n");
  });
});

describe("buildReport", () => {
  it("attaches permalinks by sourceTs and totals the hours", () => {
    const days = validateDays([day("2026-06-01", 3, { sourceTs: "100.1" })]);
    const report = buildReport(
      days,
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      new Map([["100.1", "https://orientsai.slack.com/archives/C/p1001"]]),
    );
    expect(report.sourceChannel).toBe("field-qa");
    expect(report.days[0].permalink).toBe("https://orientsai.slack.com/archives/C/p1001");
    expect(report.totals).toEqual({ days: 1, flightHours: 3 });
  });
});

describe("formatTable", () => {
  it("renders rows and a total line", () => {
    const days = validateDays([day("2026-06-01", 3), day("2026-06-02", 4)]);
    const table = formatTable(
      buildReport(days, { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, new Map()),
    );
    expect(table).toContain("2026-06-01");
    expect(table).toMatch(/TOTAL/i);
    expect(table).toContain("7");
  });
});
