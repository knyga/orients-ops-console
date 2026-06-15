import { describe, expect, it } from "vitest";
import type { DevStatsSummary } from "../lib/devStats";
import {
  defaultMonthWindow,
  formatTable,
  parseArgs,
  resolvePeriod,
} from "./githubStats";

describe("parseArgs", () => {
  it("parses --start, --end, and --format", () => {
    expect(
      parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--format", "table"]),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31", format: "table" });
  });

  it("defaults format to json and leaves dates undefined when absent", () => {
    expect(parseArgs([])).toEqual({ start: undefined, end: undefined, format: "json" });
  });

  it("--format table gives table", () => {
    expect(parseArgs(["--format", "table"])).toEqual({
      start: undefined,
      end: undefined,
      format: "table",
    });
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
    const period = resolvePeriod(
      { start: "2026-05-01", end: "2026-05-31", format: "json" },
      "2026-06-15",
    );
    expect(period).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("falls back to the current month when bounds are omitted", () => {
    const period = resolvePeriod({ format: "json" }, "2026-06-15");
    expect(period).toEqual({ start: "2026-06-01", end: "2026-06-15" });
  });

  it("ignores a lone start bound and uses the full current month", () => {
    expect(resolvePeriod({ start: "2026-05-01", format: "json" }, "2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("ignores a lone end bound and uses the full current month", () => {
    expect(resolvePeriod({ end: "2026-05-31", format: "json" }, "2026-06-15")).toEqual({
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
  it("renders header, totals, contributor rows, bot tag, and repo name", () => {
    const summary: DevStatsSummary = {
      org: "orients-ai",
      period: { start: "2026-06-01", end: "2026-06-15" },
      totals: {
        repos: 2,
        contributors: 1,
        commits: 10,
        additions: 500,
        deletions: 80,
        net: 420,
        prsOpened: 3,
        prsMerged: 2,
      },
      contributors: [
        {
          key: "login:alice",
          login: "alice",
          displayName: "alice",
          isBot: false,
          unlinked: false,
          commits: 8,
          additions: 400,
          deletions: 60,
          net: 340,
          prsOpened: 2,
          prsMerged: 2,
        },
        {
          key: "login:dependabot[bot]",
          login: "dependabot[bot]",
          displayName: "dependabot[bot]",
          isBot: true,
          unlinked: false,
          commits: 2,
          additions: 100,
          deletions: 20,
          net: 80,
          prsOpened: 1,
          prsMerged: 0,
        },
      ],
      repos: [
        {
          repo: "orients-ai/ops-console",
          commits: 7,
          additions: 300,
          deletions: 50,
          net: 250,
          prsOpened: 2,
          prsMerged: 1,
          activityScore: 10,
        },
      ],
    };

    const out = formatTable(summary);
    expect(out).toContain("GitHub activity: orients-ai");
    expect(out).toContain("2026-06-01");
    expect(out).toContain("2026-06-15");
    expect(out).toContain("alice");
    expect(out).toContain("[bot]");
    expect(out).toContain("orients-ai/ops-console");
  });
});
