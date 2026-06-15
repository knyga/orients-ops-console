import { describe, expect, it } from "vitest";
import {
  defaultMonthWindow,
  formatTable,
  parseArgs,
  reportFileName,
  resolvePeriod,
  toCsv,
  type JiraReport,
} from "./jiraReport";

describe("parseArgs", () => {
  it("parses --start, --end, and --format", () => {
    expect(
      parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--format", "table"]),
    ).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
      format: "table",
      write: false,
      summarize: false,
    });
  });

  it("defaults format to json and leaves dates undefined when absent", () => {
    expect(parseArgs([])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      write: false,
      summarize: false,
    });
  });

  it("unrecognized --format value falls back to json", () => {
    expect(parseArgs(["--format", "csv"])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      write: false,
      summarize: false,
    });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["--verbose", "--start", "2026-05-01", "--unknown", "val"])).toEqual({
      start: "2026-05-01",
      end: undefined,
      format: "json",
      write: false,
      summarize: false,
    });
  });

  it("sets write when --write is present", () => {
    expect(parseArgs(["--write"])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      write: true,
      summarize: false,
    });
  });

  it("sets summarize when --summarize is present", () => {
    expect(parseArgs(["--summarize"])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      write: false,
      summarize: true,
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
      resolvePeriod(
        { start: "2026-05-01", end: "2026-05-31", format: "json", write: false, summarize: false },
        "2026-06-15",
      ),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("falls back to the current month when bounds are omitted", () => {
    expect(
      resolvePeriod({ format: "json", write: false, summarize: false }, "2026-06-15"),
    ).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("ignores a lone start bound and uses the full current month", () => {
    expect(
      resolvePeriod(
        { start: "2026-05-01", format: "json", write: false, summarize: false },
        "2026-06-15",
      ),
    ).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("throws on a malformed explicit bound", () => {
    expect(() =>
      resolvePeriod(
        { start: "06/01/2026", end: "2026-05-31", format: "json", write: false, summarize: false },
        "2026-06-15",
      ),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("formatTable", () => {
  const report: JiraReport = {
    rows: [
      {
        accountId: "acc-1",
        displayName: "Alice Dev",
        resolvedCount: 5,
        storyPoints: 13,
        issueKeys: ["ATP-1", "ATP-2", "ATP-3", "ATP-4", "ATP-5"],
      },
      {
        accountId: null,
        displayName: "Unassigned",
        resolvedCount: 2,
        storyPoints: 0,
        issueKeys: ["ATP-9", "ATP-10"],
      },
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
    // per-user resolved issue keys appear in the row
    expect(out).toContain("Issues");
    expect(out).toContain("ATP-1, ATP-2, ATP-3, ATP-4, ATP-5");
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

describe("reportFileName", () => {
  it("uses YYYY-MM when the window is within a single calendar month", () => {
    expect(reportFileName({ start: "2025-05-01", end: "2025-05-31" })).toBe("2025-05.csv");
  });

  it("uses start_end when the window spans multiple months", () => {
    expect(reportFileName({ start: "2025-04-15", end: "2025-05-10" })).toBe(
      "2025-04-15_2025-05-10.csv",
    );
  });
});

describe("toCsv", () => {
  it("emits a header and one row per user, story points preserved", () => {
    const csv = toCsv({
      rows: [
        {
          accountId: "acc-1",
          displayName: "Alice Dev",
          resolvedCount: 5,
          storyPoints: 13.5,
          issueKeys: ["ATP-1", "ATP-2"],
        },
        {
          accountId: null,
          displayName: "Unassigned",
          resolvedCount: 2,
          storyPoints: 0,
          issueKeys: ["ATP-9", "ATP-10"],
        },
      ],
      totals: { totalResolved: 7, totalStoryPoints: 13.5 },
      sprintChurn: [],
    });
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("user,resolvedCount,storyPoints,issues,summary");
    // no summaries map → empty summary column
    expect(lines[1]).toBe("Alice Dev,5,13.5,ATP-1 ATP-2,");
    expect(lines[2]).toBe("Unassigned,2,0,ATP-9 ATP-10,");
  });

  it("fills the summary column from a summaries map, keyed by accountId", () => {
    const summaries = new Map<string | null, string>([
      ["acc-1", "Led the detection pipeline work."],
      [null, "Misc unassigned cleanup, commas, and \"quotes\"."],
    ]);
    const csv = toCsv(
      {
        rows: [
          {
            accountId: "acc-1",
            displayName: "Alice Dev",
            resolvedCount: 1,
            storyPoints: 2,
            issueKeys: ["ATP-1"],
          },
          {
            accountId: null,
            displayName: "Unassigned",
            resolvedCount: 1,
            storyPoints: 0,
            issueKeys: ["ATP-2"],
          },
        ],
        totals: { totalResolved: 2, totalStoryPoints: 2 },
        sprintChurn: [],
      },
      summaries,
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[1]).toBe("Alice Dev,1,2,ATP-1,Led the detection pipeline work.");
    // summary with commas/quotes is RFC-4180 escaped
    expect(lines[2]).toBe(
      'Unassigned,1,0,ATP-2,"Misc unassigned cleanup, commas, and ""quotes""."',
    );
  });

  it("escapes names containing commas or quotes per RFC 4180", () => {
    const csv = toCsv({
      rows: [
        {
          accountId: "x",
          displayName: 'Doe, "JD" Jr',
          resolvedCount: 1,
          storyPoints: 2,
          issueKeys: ["ATP-1"],
        },
      ],
      totals: { totalResolved: 1, totalStoryPoints: 2 },
      sprintChurn: [],
    });
    expect(csv.trimEnd().split("\n")[1]).toBe('"Doe, ""JD"" Jr",1,2,ATP-1,');
  });
});
