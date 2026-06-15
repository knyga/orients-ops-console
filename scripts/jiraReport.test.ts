import { describe, expect, it } from "vitest";
import {
  defaultMonthWindow,
  formatTable,
  parseArgs,
  resolvePeriod,
  type JiraReport,
} from "./jiraReport";

describe("parseArgs", () => {
  it("parses --start, --end, and --format", () => {
    expect(
      parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--format", "table"]),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31", format: "table" });
  });

  it("defaults format to json and leaves dates undefined when absent", () => {
    expect(parseArgs([])).toEqual({ start: undefined, end: undefined, format: "json" });
  });

  it("unrecognized --format value falls back to json", () => {
    expect(parseArgs(["--format", "csv"])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
    });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["--verbose", "--start", "2026-05-01", "--unknown", "val"])).toEqual({
      start: "2026-05-01",
      end: undefined,
      format: "json",
    });
  });
});

describe("defaultMonthWindow", () => {
  it("spans the first of the month to today", () => {
    expect(defaultMonthWindow("2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when both are given", () => {
    expect(
      resolvePeriod({ start: "2026-05-01", end: "2026-05-31", format: "json" }, "2026-06-15"),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("falls back to the current month when bounds are omitted", () => {
    expect(resolvePeriod({ format: "json" }, "2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("ignores a lone start bound and uses the full current month", () => {
    expect(resolvePeriod({ start: "2026-05-01", format: "json" }, "2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("throws on a malformed explicit bound", () => {
    expect(() =>
      resolvePeriod({ start: "06/01/2026", end: "2026-05-31", format: "json" }, "2026-06-15"),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("formatTable", () => {
  const report: JiraReport = {
    rows: [
      { accountId: "acc-1", displayName: "Alice Dev", resolvedCount: 5, storyPoints: 13 },
      { accountId: null, displayName: "Unassigned", resolvedCount: 2, storyPoints: 0 },
    ],
    totals: { totalResolved: 7, totalStoryPoints: 13 },
    sprintChurn: [
      {
        issueKey: "ATP-42",
        summary: "Fix the thing",
        changes: [
          { from: "ATP 37", to: "ATP 38", when: "2026-06-02T10:00:00.000Z" },
          { from: "ATP 38", to: "", when: "2026-06-09T10:00:00.000Z" },
        ],
      },
    ],
  };

  it("renders header, period, totals, user rows, and sprint churn", () => {
    const out = formatTable({ start: "2026-06-01", end: "2026-06-15" }, report);
    expect(out).toContain("Jira dev reporting");
    expect(out).toContain("2026-06-01");
    expect(out).toContain("2026-06-15");
    expect(out).toContain("Alice Dev");
    expect(out).toContain("Unassigned");
    expect(out).toContain("Resolved 7");
    expect(out).toContain("Story points 13");
    expect(out).toContain("ATP-42");
    expect(out).toContain("ATP 37 → ATP 38");
    // empty sprint side renders as a dash
    expect(out).toContain("ATP 38 → —");
  });

  it("notes when no issues changed sprints", () => {
    const out = formatTable(
      { start: "2026-06-01", end: "2026-06-15" },
      { rows: [], totals: { totalResolved: 0, totalStoryPoints: 0 }, sprintChurn: [] },
    );
    expect(out).toContain("No issues changed sprints");
  });
});
