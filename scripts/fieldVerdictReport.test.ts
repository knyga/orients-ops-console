import { describe, expect, it } from "vitest";
import { buildReport, formatTable, mergeFlightDays, parseArgs, resolvePeriod, summarize, toCsv, type FlightDayInput } from "./fieldVerdictReport";
import type { DayVerdict } from "../lib/fieldDayVerdict";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-16",
  status: "ACCEPTED",
  airborneMinutes: 20,
  videoMinutes: 12,
  ratio: 0.6,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
  ...over,
});

describe("parseArgs / resolvePeriod", () => {
  it("defaults to the current month when bounds omitted", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-19")).toEqual({ start: "2026-06-01", end: "2026-06-19" });
  });
  it("reads --start/--end and --write", () => {
    const a = parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--write"]);
    expect(a.write).toBe(true);
    expect(resolvePeriod(a, "2026-06-19")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });
});

describe("summarize / buildReport / toCsv", () => {
  it("counts each status", () => {
    const s = summarize([day({}), day({ status: "PENDING" }), day({ status: "NEEDS_REVIEW" }), day({ status: "ACCEPTED_EXCEPTION" }), day({ status: "REJECTED" })]);
    expect(s).toEqual({ accepted: 1, pending: 1, needsReview: 1, acceptedException: 1, rejected: 1 });
  });

  it("buildReport assembles period + summary", () => {
    const r = buildReport([day({})], { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3);
    expect(r.summary.accepted).toBe(1);
    expect(r.days).toHaveLength(1);
  });

  it("toCsv emits a header + one row per day, escaping reasons", () => {
    const csv = toCsv(buildReport([day({ status: "NEEDS_REVIEW", reasons: ["video < 50%, no dataset"] })], { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3));
    expect(csv.split("\n")[0]).toBe("date,status,airborneMinutes,videoMinutes,ratio,datasetStatus,reasons,roster");
    expect(csv).toMatch(/"video < 50%, no dataset"/);
  });

  it("CSV header carries datasetStatus and the row prints the status", () => {
    const report = buildReport(
      [{ date: "2026-06-10", status: "ACCEPTED", airborneMinutes: 100, videoMinutes: 60, ratio: 0.6, datasetStatus: "WAIVED", withinGrace: false, reasons: [], roster: [], unknownInitials: [], airborneReported: true }],
      { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3,
    );
    const csv = toCsv(report);
    expect(csv.split("\n")[0]).toContain("datasetStatus");
    expect(csv).toContain("WAIVED");
  });
});

describe("crew column", () => {
  it("renders the crew (and ? for unknown initials) in the table and CSV", () => {
    const report = buildReport(
      [day({ date: "2026-06-10", roster: ["Андріан"], unknownInitials: ["Ж"] })],
      { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3,
    );
    expect(formatTable(report)).toContain("Андріан");
    expect(formatTable(report)).toContain("?Ж");
    expect(toCsv(report)).toContain("Андріан");
  });
});

describe("mergeFlightDays", () => {
  const p = (flightDate: string, deployMin: number | null, start: string | null = null, end: string | null = null) =>
    ({ flightDate, deployMin, start, end });

  it("includes airborne-report dates as reported, preserving minutes", () => {
    const out = mergeFlightDays(new Map([["2026-06-01", 36.8]]), []);
    expect(out).toEqual([{ date: "2026-06-01", airborneMinutes: 36.8, airborneReported: true, deployWindow: undefined }]);
  });

  it("adds a parsed-only date WITH a deployment window as not-reported (airborne 0) + its window", () => {
    const out = mergeFlightDays(new Map(), [p("2026-06-21", 180, "17:00", "20:00")]);
    expect(out).toEqual([{ date: "2026-06-21", airborneMinutes: 0, airborneReported: false, deployWindow: { start: "17:00", end: "20:00" } }]);
  });

  it("excludes a parsed date with no deployment window (deployMin null)", () => {
    const out = mergeFlightDays(new Map(), [p("2026-06-21", null)]);
    expect(out).toEqual([]);
  });

  it("gives the airborne report precedence for a date present in both", () => {
    const out = mergeFlightDays(new Map([["2026-06-21", 40]]), [p("2026-06-21", 180, "17:00", "20:00")]);
    expect(out).toEqual([{ date: "2026-06-21", airborneMinutes: 40, airborneReported: true, deployWindow: { start: "17:00", end: "20:00" } }]);
  });

  it("sorts the union ascending by date", () => {
    const out = mergeFlightDays(new Map([["2026-06-05", 30]]), [p("2026-06-02", 120, "10:00", "12:00")]);
    expect(out.map((d) => d.date)).toEqual(["2026-06-02", "2026-06-05"]);
  });
});
