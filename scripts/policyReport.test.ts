import { describe, expect, it } from "vitest";
import type { PolicySchedule } from "../lib/policySchedule";
import { applyVerdicts, parseArgs, resolvePeriod, toCsv } from "./policyReport";

const schedule: PolicySchedule = {
  period: { start: "2026-05-01", end: "2026-05-31" },
  occurrences: [
    {
      id: "weekly-budget-status:2026-05-04",
      obligationId: "weekly-budget-status",
      title: "Weekly budget status report",
      channel: "budgets",
      dueDate: "2026-05-04",
      windowStart: "2026-05-04",
      windowEnd: "2026-05-05",
      status: "NEEDS_REVIEW",
      candidates: [
        {
          authorId: "U1",
          author: "Maryna",
          isoTime: "2026-05-04T09:00:00.000Z",
          excerpt: "Weekly budget, all good",
          permalink: "https://x.slack.com/archives/C/p1",
        },
      ],
    },
  ],
  skipped: [{ obligationId: "drone-remainder-report", reason: "per-event cadence not scheduled in v1" }],
};

describe("parseArgs", () => {
  it("parses bounds, --write, --dump-occurrences and --verdicts-file", () => {
    const args = parseArgs([
      "--start", "2026-05-01", "--end", "2026-05-31",
      "--write", "--dump-occurrences", "--verdicts-file", "v.json", "--format", "table",
    ]);
    expect(args).toMatchObject({
      start: "2026-05-01", end: "2026-05-31", write: true,
      dumpOccurrences: true, verdictsFile: "v.json", format: "table",
    });
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when both present", () => {
    expect(resolvePeriod(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31"]), "2026-06-16"))
      .toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("falls back to the current month when a bound is missing", () => {
    expect(resolvePeriod(parseArgs(["--start", "2026-05-01"]), "2026-06-16"))
      .toEqual({ start: "2026-06-01", end: "2026-06-16" });
  });
});

describe("applyVerdicts", () => {
  it("merges a verdict onto its occurrence by id and leaves others bare", () => {
    const report = applyVerdicts(schedule, "2026-06-16", {
      "weekly-budget-status:2026-05-04": { verdict: "DONE", rationale: "Posted on time." },
    });
    expect(report.runDate).toBe("2026-06-16");
    expect(report.occurrences[0].verdict).toBe("DONE");
    expect(report.occurrences[0].rationale).toBe("Posted on time.");
    expect(report.skipped).toHaveLength(1);
  });
});

describe("toCsv", () => {
  it("emits one row per occurrence with a stable header and quotes free text", () => {
    const report = applyVerdicts(schedule, "2026-06-16", {
      "weekly-budget-status:2026-05-04": { verdict: "DONE", rationale: "On time, no issues" },
    });
    const csv = toCsv(report);
    expect(csv.split("\n")[0]).toBe(
      "obligation,channel,dueDate,status,verdict,rationale,evidenceCount",
    );
    expect(csv).toContain("Weekly budget status report,budgets,2026-05-04,NEEDS_REVIEW,DONE,");
    expect(csv).toContain('"On time, no issues"');
    expect(csv.endsWith("\n")).toBe(true);
  });
});
