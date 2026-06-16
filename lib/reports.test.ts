import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listPeriods,
  parsePeriodKey,
  periodKey,
  readReportJson,
  writeReport,
} from "./reports";

describe("periodKey", () => {
  it("collapses a single-calendar-month window to YYYY-MM", () => {
    expect(periodKey({ start: "2026-05-01", end: "2026-05-31" })).toBe("2026-05");
    // any window inside one month collapses, even a partial one
    expect(periodKey({ start: "2026-05-03", end: "2026-05-20" })).toBe("2026-05");
  });

  it("keeps both bounds for a cross-month window", () => {
    expect(periodKey({ start: "2026-04-15", end: "2026-05-10" })).toBe(
      "2026-04-15_2026-05-10",
    );
  });
});

describe("parsePeriodKey", () => {
  it("expands a month key to the first..last day of the month", () => {
    expect(parsePeriodKey("2026-05")).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
    // February in a leap year (2028) → 29 days
    expect(parsePeriodKey("2028-02")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });

  it("returns the two bounds of a range key verbatim", () => {
    expect(parsePeriodKey("2026-04-15_2026-05-10")).toEqual({
      start: "2026-04-15",
      end: "2026-05-10",
    });
  });

  it("round-trips with periodKey for a month window", () => {
    const period = parsePeriodKey("2026-05")!;
    expect(periodKey(period)).toBe("2026-05");
  });

  it("returns null for malformed keys", () => {
    expect(parsePeriodKey("nonsense")).toBeNull();
    expect(parsePeriodKey("2026/05")).toBeNull();
    expect(parsePeriodKey("2026-05-01_garbage")).toBeNull();
    expect(parsePeriodKey("")).toBeNull();
  });
});

describe("writeReport / readReportJson / listPeriods", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "reports-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes both sidecars and round-trips the JSON", () => {
    const period = { start: "2026-05-01", end: "2026-05-31" };
    const payload = { totalResolved: 7, rows: [{ user: "A", n: 3 }] };
    const { key, jsonPath, csvPath } = writeReport(
      "jira",
      period,
      { json: JSON.stringify(payload), csv: "user,n\nA,3\n" },
      { baseDir },
    );

    expect(key).toBe("2026-05");
    expect(jsonPath.endsWith("jira/2026-05.json")).toBe(true);
    expect(csvPath.endsWith("jira/2026-05.csv")).toBe(true);
    expect(readFileSync(csvPath, "utf8")).toBe("user,n\nA,3\n");
    expect(readReportJson("jira", "2026-05", { baseDir })).toEqual(payload);
  });

  it("returns null for an absent artifact", () => {
    expect(readReportJson("jira", "1999-01", { baseDir })).toBeNull();
  });

  it("lists committed periods newest-first; empty/missing dir → []", () => {
    expect(listPeriods("github", { baseDir })).toEqual([]);

    const blank = { json: "{}", csv: "" };
    writeReport("github", { start: "2026-01-01", end: "2026-01-31" }, blank, { baseDir });
    writeReport("github", { start: "2026-03-01", end: "2026-03-31" }, blank, { baseDir });
    writeReport("github", { start: "2026-02-01", end: "2026-02-28" }, blank, { baseDir });

    expect(listPeriods("github", { baseDir })).toEqual([
      "2026-03",
      "2026-02",
      "2026-01",
    ]);
  });
});
