import { describe, expect, it } from "vitest";
import type { ExtractedDay } from "./fieldQaReport";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toInputsCsv,
  validateDays,
} from "./fieldQaReport";
import type { DroneEntry } from "../lib/droneReport";

function day(date: string, airborneSeconds: number, extra: Partial<ExtractedDay> = {}): ExtractedDay {
  return { date, airborneSeconds, flights: 1, flew: airborneSeconds > 0, sourceTs: "1.0", ...extra };
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
  it("ignores a lone bound and uses the full current month", () => {
    // A lone --start (not the month's first day) is overwritten, proving the
    // all-or-nothing behavior rather than passing by coincidence.
    expect(
      resolvePeriod({ format: "json", write: false, start: "2026-06-10" }, "2026-06-18"),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", timezone: "Europe/Kyiv" });
    expect(
      resolvePeriod({ format: "json", write: false, end: "2026-06-30" }, "2026-06-18"),
    ).toEqual({ start: "2026-06-01", end: "2026-06-18", timezone: "Europe/Kyiv" });
  });
  it("throws on a malformed date", () => {
    expect(() =>
      resolvePeriod({ format: "json", write: false, start: "06/01", end: "2026-06-18" }, "2026-06-18"),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("validateDays", () => {
  it("keeps telemetry-confirmed no-fly (0) days, drops negative/NaN/bad-date, dedupes, sorts", () => {
    const r = validateDays([
      day("2026-06-02", 1200),
      day("2026-06-01", 1110, { sourceTs: "100.1" }),
      day("2026-06-01", 999, { sourceTs: "100.9" }),
      day("2026-06-03", 0),      // no-fly: KEPT now
      day("2026-06-05", -5),     // negative: dropped
      day("bad-date", 600),
      day("2026-06-04", Number.NaN),
    ]);
    expect(r.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    expect(r[0].airborneSeconds).toBe(1110); // first/kept for the date
    expect(r[0].sourceTs).toBe("100.1");
    expect(r.find((d) => d.date === "2026-06-03")!.flew).toBe(false);
  });

  it("drops a contradictory flew:true / 0-airborne reading (never masquerades as no-fly)", () => {
    const r = validateDays([
      day("2026-06-07", 900), // normal flown
      day("2026-06-08", 0, { flew: true }), // flew but 0 airborne — malformed read, dropped
      day("2026-06-09", 0), // genuine no-fly (flew:false) — kept
    ]);
    expect(r.map((d) => d.date)).toEqual(["2026-06-07", "2026-06-09"]);
    expect(r.find((d) => d.date === "2026-06-09")!.flew).toBe(false);
  });
});

describe("toInputsCsv", () => {
  it("emits date,flight_hours from airborne seconds", () => {
    const csv = toInputsCsv(validateDays([day("2026-06-18", 1110), day("2026-06-13", 1217)]));
    // 1110/3600=0.31 (round2), 1217/3600=0.34
    expect(csv).toBe("date,flight_hours\n2026-06-13,0.34\n2026-06-18,0.31\n");
  });

  it("excludes no-fly (0) days from the flight-hours feed", () => {
    const csv = toInputsCsv(validateDays([day("2026-06-13", 1217), day("2026-06-14", 0)]));
    expect(csv).toBe("date,flight_hours\n2026-06-13,0.34\n");
  });
});

describe("buildReport", () => {
  it("reports airborne minutes + permalink and totals the hours", () => {
    const days = validateDays([day("2026-06-18", 1110, { sourceTs: "100.1" })]);
    const report = buildReport(
      days,
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      new Map([["100.1", "https://orientsai.slack.com/p1"]]),
    );
    expect(report.sourceChannel).toBe("field-qa");
    expect(report.days[0].airborneMinutes).toBe(18.5); // 1110/60
    expect(report.days[0].flightHours).toBe(0.31);
    expect(report.days[0].permalink).toBe("https://orientsai.slack.com/p1");
    expect(report.totals.days).toBe(1);
  });

  it("includes no-fly days in report.days but counts only flown days in totals", () => {
    const days = validateDays([day("2026-06-18", 1110), day("2026-06-19", 0)]);
    const report = buildReport(days, { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, new Map());
    expect(report.days.map((d) => d.date)).toEqual(["2026-06-18", "2026-06-19"]);
    const noFly = report.days.find((d) => d.date === "2026-06-19")!;
    expect(noFly.flew).toBe(false);
    expect(noFly.airborneMinutes).toBe(0);
    expect(noFly.flights).toBe(0); // no-fly ⇒ 0 flights (never a phantom count)
    expect(report.totals.days).toBe(1); // only the flown day counts
  });
});

describe("formatTable", () => {
  it("renders rows and a total line", () => {
    const days = validateDays([day("2026-06-18", 1110), day("2026-06-13", 1217)]);
    const table = formatTable(
      buildReport(days, { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, new Map()),
    );
    expect(table).toContain("2026-06-18");
    expect(table).toMatch(/TOTAL/i);
  });
});

describe("buildReport drone attachment", () => {
  const PERIOD = { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" };
  const testDay = (date: string): ExtractedDay => ({
    date,
    airborneSeconds: 600,
    flights: 1,
    flew: true,
    sourceTs: `${date}-ts`,
  });

  const extraction = (over: {
    byDate?: Map<string, DroneEntry[]>;
    submittersByDate?: Map<string, Set<string>>;
    failedDates?: Set<string>;
  }) => ({
    byDate: over.byDate ?? new Map<string, DroneEntry[]>(),
    submittersByDate: over.submittersByDate ?? new Map<string, Set<string>>(),
    failedDates: over.failedDates ?? new Set<string>(),
  });

  it("attaches drone entries by date; a classified-and-none day gets an explicit []", () => {
    const drones = extraction({
      byDate: new Map([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 2 }]]]),
    });
    const report = buildReport([testDay("2026-06-25"), testDay("2026-06-26")], PERIOD, new Map(), drones);
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([
      { name: "Андріан", isPerson: true, count: 2 },
    ]);
    // Extraction ran and found nothing for 06-26 → explicit [] ("ran, found
    // none"), never an absent key (which would mean "unknown / never ran").
    expect(report.days.find((d) => d.date === "2026-06-26")?.droneReport).toEqual([]);
  });

  it("omits the droneReport key for a date whose classification failed (unknown, not [])", () => {
    const drones = extraction({
      byDate: new Map([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 2 }]]]),
      failedDates: new Set(["2026-06-26"]),
    });
    const report = buildReport(
      [testDay("2026-06-25"), testDay("2026-06-26"), testDay("2026-06-27")],
      PERIOD,
      new Map(),
      drones,
    );
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneReport).toEqual([
      { name: "Андріан", isPerson: true, count: 2 },
    ]);
    expect(report.days.find((d) => d.date === "2026-06-26")).not.toHaveProperty("droneReport");
    expect(report.days.find((d) => d.date === "2026-06-27")?.droneReport).toEqual([]);
  });

  it("omits droneReport entirely when no extraction is passed", () => {
    const report = buildReport([testDay("2026-06-25")], PERIOD, new Map());
    expect(report.days[0]).not.toHaveProperty("droneReport");
    expect(report.days[0]).not.toHaveProperty("droneSubmitters");
  });

  it("attaches sorted droneSubmitters with the same tri-state as droneReport", () => {
    const drones = extraction({
      byDate: new Map([["2026-06-25", [{ name: "Андріан", isPerson: true, count: 2 }]]]),
      submittersByDate: new Map([["2026-06-25", new Set(["U2", "U1"])]]),
      failedDates: new Set(["2026-06-27"]),
    });
    const report = buildReport(
      [testDay("2026-06-25"), testDay("2026-06-26"), testDay("2026-06-27")],
      PERIOD,
      new Map(),
      drones,
    );
    expect(report.days.find((d) => d.date === "2026-06-25")?.droneSubmitters).toEqual(["U1", "U2"]);
    // ran, nobody submitted → explicit []
    expect(report.days.find((d) => d.date === "2026-06-26")?.droneSubmitters).toEqual([]);
    // classification failed → unknown → no key
    expect(report.days.find((d) => d.date === "2026-06-27")).not.toHaveProperty("droneSubmitters");
  });
});
