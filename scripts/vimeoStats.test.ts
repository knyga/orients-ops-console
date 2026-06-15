import { describe, expect, it } from "vitest";
import type { VimeoVideo } from "../lib/vimeo";
import {
  buildStats,
  defaultMonthWindow,
  formatTable,
  parseArgs,
  resolvePeriod,
} from "./vimeoStats";

/** A Vimeo video uploaded at noon Kyiv on `date` (stable day mapping). */
function videoOn(
  date: string,
  durationSeconds: number,
  name = "clip",
): VimeoVideo {
  return {
    name,
    duration: durationSeconds,
    description: null,
    created_time: `${date}T12:00:00+00:00`,
    link: `https://vimeo.com/${name}`,
    pictures: { base_link: "" },
  };
}

describe("parseArgs", () => {
  it("reads --start, --end and --format", () => {
    expect(
      parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--format", "table"]),
    ).toEqual({ start: "2026-05-01", end: "2026-05-31", format: "table" });
  });

  it("defaults format to json and leaves dates undefined when absent", () => {
    expect(parseArgs([])).toEqual({ start: undefined, end: undefined, format: "json" });
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
    expect(period).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
      timezone: "Europe/Kyiv",
    });
  });

  it("falls back to the current month when bounds are omitted", () => {
    const period = resolvePeriod({ format: "json" }, "2026-06-15");
    expect(period).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
      timezone: "Europe/Kyiv",
    });
  });

  it("ignores a lone bound and uses the full current month", () => {
    expect(resolvePeriod({ start: "2026-05-01", format: "json" }, "2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
      timezone: "Europe/Kyiv",
    });
    expect(resolvePeriod({ end: "2026-05-31", format: "json" }, "2026-06-15")).toEqual({
      start: "2026-06-01",
      end: "2026-06-15",
      timezone: "Europe/Kyiv",
    });
  });

  it("throws on a malformed date", () => {
    expect(() =>
      resolvePeriod({ start: "2026/05/01", end: "2026-05-31", format: "json" }, "2026-06-15"),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("buildStats", () => {
  it("groups by upload day and totals counts and minutes", () => {
    const videos = [
      videoOn("2026-05-01", 1800, "a"), // 30 min
      videoOn("2026-05-01", 1800, "b"), // 30 min
      videoOn("2026-05-02", 600, "c"), // 10 min
    ];
    const stats = buildStats(videos, {
      start: "2026-05-01",
      end: "2026-05-31",
      timezone: "Europe/Kyiv",
    });

    expect(stats.totals).toEqual({ videoCount: 3, recordedMinutes: 70 });
    expect(stats.byDay).toEqual([
      { date: "2026-05-01", videoCount: 2, recordedMinutes: 60 },
      { date: "2026-05-02", videoCount: 1, recordedMinutes: 10 },
    ]);
    expect(stats.videos).toEqual([
      { date: "2026-05-01", minutes: 30, name: "a", link: "https://vimeo.com/a" },
      { date: "2026-05-01", minutes: 30, name: "b", link: "https://vimeo.com/b" },
      { date: "2026-05-02", minutes: 10, name: "c", link: "https://vimeo.com/c" },
    ]);
    expect(stats.period.start).toBe("2026-05-01");
  });

  it("never emits a reconciliation status or ratio", () => {
    const stats = buildStats([videoOn("2026-05-01", 600)], {
      start: "2026-05-01",
      end: "2026-05-31",
      timezone: "Europe/Kyiv",
    });
    const dayKeys = Object.keys(stats.byDay[0]);
    expect(dayKeys).not.toContain("status");
    expect(dayKeys).not.toContain("ratio");
  });
});

describe("formatTable", () => {
  it("renders per-day rows and a totals line", () => {
    const stats = buildStats(
      [videoOn("2026-05-01", 1800), videoOn("2026-05-02", 600)],
      { start: "2026-05-01", end: "2026-05-31", timezone: "Europe/Kyiv" },
    );
    const table = formatTable(stats);
    expect(table).toContain("2026-05-01");
    expect(table).toContain("2026-05-02");
    expect(table).toMatch(/TOTAL/i);
    expect(table).toContain("2026-05-01 … 2026-05-31"); // period header
  });
});
