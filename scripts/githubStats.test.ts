import { describe, expect, it } from "vitest";
import type { DevStatsSummary } from "../lib/devStats";
import {
  defaultMonthWindow,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
} from "./githubStats";

const FLAG_DEFAULTS = {
  write: false,
  summarize: false,
  summariesFile: undefined,
  dumpWork: false,
};

describe("parseArgs", () => {
  it("parses --start, --end, and --format", () => {
    expect(
      parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--format", "table"]),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31", format: "table", ...FLAG_DEFAULTS });
  });

  it("defaults format to json and leaves dates undefined when absent", () => {
    expect(parseArgs([])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      ...FLAG_DEFAULTS,
    });
  });

  it("--format table gives table", () => {
    expect(parseArgs(["--format", "table"])).toEqual({
      start: undefined,
      end: undefined,
      format: "table",
      ...FLAG_DEFAULTS,
    });
  });

  it("unrecognized --format value falls back to json", () => {
    expect(parseArgs(["--format", "csv"])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      ...FLAG_DEFAULTS,
    });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["--verbose", "--start", "2026-05-01", "--unknown", "val"])).toEqual({
      start: "2026-05-01",
      end: undefined,
      format: "json",
      ...FLAG_DEFAULTS,
    });
  });

  it("captures --write, --summarize, --summaries-file and --dump-work", () => {
    expect(
      parseArgs(["--write", "--summarize", "--summaries-file", "/tmp/s.json", "--dump-work"]),
    ).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      write: true,
      summarize: true,
      summariesFile: "/tmp/s.json",
      dumpWork: true,
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
      { start: "2026-05-01", end: "2026-05-31", format: "json", ...FLAG_DEFAULTS },
      "2026-06-15",
    );
    expect(period).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("falls back to the current month when bounds are omitted", () => {
    const period = resolvePeriod({ format: "json", ...FLAG_DEFAULTS }, "2026-06-15");
    expect(period).toEqual({ start: "2026-06-01", end: "2026-06-15" });
  });

  it("ignores a lone start bound and uses the full current month", () => {
    expect(
      resolvePeriod({ start: "2026-05-01", format: "json", ...FLAG_DEFAULTS }, "2026-06-15"),
    ).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("ignores a lone end bound and uses the full current month", () => {
    expect(
      resolvePeriod({ end: "2026-05-31", format: "json", ...FLAG_DEFAULTS }, "2026-06-15"),
    ).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
    });
  });

  it("throws on a malformed explicit bound", () => {
    expect(() =>
      resolvePeriod(
        { start: "06/01/2026", end: "2026-05-31", format: "json", ...FLAG_DEFAULTS },
        "2026-06-15",
      ),
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
        {
          key: "name:No Account",
          login: null,
          displayName: "No Account",
          isBot: false,
          unlinked: true,
          commits: 1,
          additions: 50,
          deletions: 10,
          net: 40,
          prsOpened: 0,
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
    expect(out).toContain("(unlinked)");
    expect(out).toContain("+340");
  });
});

describe("toCsv", () => {
  const summary: DevStatsSummary = {
    org: "orients-ai",
    period: { start: "2026-06-01", end: "2026-06-15" },
    totals: {
      repos: 1,
      contributors: 2,
      commits: 9,
      additions: 450,
      deletions: 70,
      net: 380,
      prsOpened: 2,
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
        key: "name:No Account",
        login: null,
        displayName: "No, Account",
        isBot: false,
        unlinked: true,
        commits: 1,
        additions: 50,
        deletions: 10,
        net: 40,
        prsOpened: 0,
        prsMerged: 0,
      },
    ],
    repos: [],
  };

  it("emits a header and one row per contributor, no summaries", () => {
    const lines = toCsv(summary).trimEnd().split("\n");
    expect(lines[0]).toBe(
      "contributor,commits,additions,deletions,net,prsOpened,prsMerged,summary",
    );
    expect(lines[1]).toBe("alice,8,400,60,340,2,2,");
    // display name with a comma is RFC-4180 quoted; empty summary column present
    expect(lines[2]).toBe('"No, Account",1,50,10,40,0,0,');
  });

  it("fills the summary column from a map keyed by contributor key", () => {
    const summaries = new Map<string | null, string>([
      ["login:alice", "Led the detection pipeline work."],
    ]);
    const lines = toCsv(summary, summaries).trimEnd().split("\n");
    expect(lines[1]).toBe("alice,8,400,60,340,2,2,Led the detection pipeline work.");
    expect(lines[2]).toBe('"No, Account",1,50,10,40,0,0,');
  });
});
