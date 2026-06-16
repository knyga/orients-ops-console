import { describe, expect, it } from "vitest";
import type { FlightDay, ReconVideo } from "../lib/reconcile";
import {
  buildReconciliation,
  defaultMonthWindow,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type Period,
} from "./fieldopsReport";

const KYIV = "Europe/Kyiv";

/** A video uploaded at noon Kyiv on `date` (stable day mapping). */
function videoOn(date: string, durationSeconds: number): ReconVideo {
  return { createdTime: `${date}T12:00:00+00:00`, durationSeconds };
}

function period(start: string, end: string): Period {
  return { start, end, timezone: KYIV };
}

describe("parseArgs", () => {
  it("reads bounds, format, inputs and write", () => {
    expect(
      parseArgs([
        "--start", "2026-05-01",
        "--end", "2026-05-31",
        "--format", "table",
        "--inputs", "/tmp/f.csv",
        "--write",
      ]),
    ).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
      format: "table",
      inputs: "/tmp/f.csv",
      write: true,
    });
  });

  it("defaults format to json and leaves the rest unset", () => {
    expect(parseArgs([])).toEqual({
      start: undefined,
      end: undefined,
      format: "json",
      inputs: undefined,
      write: false,
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
  it("uses explicit bounds when both are given and carries the field timezone", () => {
    expect(
      resolvePeriod(
        { start: "2026-05-01", end: "2026-05-31", format: "json", write: false },
        "2026-06-15",
      ),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31", timezone: KYIV });
  });

  it("falls back to the current month when bounds are omitted", () => {
    expect(resolvePeriod({ format: "json", write: false }, "2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
      timezone: KYIV,
    });
  });

  it("throws on a malformed bound", () => {
    expect(() =>
      resolvePeriod(
        { start: "06/01/2026", end: "2026-05-31", format: "json", write: false },
        "2026-06-15",
      ),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("buildReconciliation", () => {
  it("applies the 50% gate (exact match passes) and flags video-only days", () => {
    const videos: ReconVideo[] = [
      videoOn("2026-05-01", 3600), // 60 min — exactly 50% of a 2h flight
      videoOn("2026-05-02", 600), // 10 min, no flight that day
    ];
    const flightDays: FlightDay[] = [{ date: "2026-05-01", flightHours: 2 }];

    const report = buildReconciliation(videos, flightDays, period("2026-05-01", "2026-05-31"), null);

    const may1 = report.daily.find((d) => d.date === "2026-05-01")!;
    expect(may1.ratio).toBe(0.5);
    expect(may1.status).toBe("OK"); // >= 50% passes

    const may2 = report.daily.find((d) => d.date === "2026-05-02")!;
    expect(may2.ratio).toBeNull();
    expect(may2.status).toBe("FLAG"); // video with no flight

    expect(report.summary.totalVideos).toBe(2);
    expect(report.summary.flaggedDays).toEqual(["2026-05-02"]);
    expect(report.flightInputPath).toBeNull();
  });
});

describe("toCsv", () => {
  it("emits a header and one row per day; blank ratio when no flight minutes", () => {
    const report = buildReconciliation(
      [videoOn("2026-05-01", 3600), videoOn("2026-05-02", 600)],
      [{ date: "2026-05-01", flightHours: 2 }],
      period("2026-05-01", "2026-05-31"),
      null,
    );
    const lines = toCsv(report).trimEnd().split("\n");
    expect(lines[0]).toBe("date,videoCount,recordedMinutes,flightMinutes,ratio,status");
    expect(lines[1]).toBe("2026-05-01,1,60,120,0.5,OK");
    expect(lines[2]).toBe("2026-05-02,1,10,0,,FLAG");
  });
});

describe("formatTable", () => {
  it("renders the period header, a totals line and per-day rows", () => {
    const report = buildReconciliation(
      [videoOn("2026-05-01", 3600)],
      [{ date: "2026-05-01", flightHours: 2 }],
      period("2026-05-01", "2026-05-31"),
      null,
    );
    const out = formatTable(report);
    expect(out).toContain("Field Ops reconciliation");
    expect(out).toContain("2026-05-01 … 2026-05-31");
    expect(out).toContain("OK");
  });
});
