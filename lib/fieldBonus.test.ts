import { describe, it, expect } from "vitest";
import { computeBonuses, roundVideoMin } from "./fieldBonus";
import type { FieldReport } from "./fieldReports";

const rep = (o: Partial<FieldReport> & { flightDate: string }): FieldReport => ({
  roster: ["Андріан"], unknownInitials: [], start: "14:00", end: "17:00", deployMin: 180,
  crashText: null, permalink: "p", threadTs: "t", ...o,
});
const period = { start: "2026-05-01", end: "2026-05-31" };

describe("computeBonuses", () => {
  it("pays 700 for a qualifying weekday trip with >=2min video", () => {
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-01" })], videoMinutesByDate: { "2026-05-01": 5 }, losses: [] });
    expect(r.people).toEqual([{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }]);
    expect(r.total).toBe(700);
  });
  it("rejects a trip with <2min video and flags it (the 05-11 anomaly)", () => {
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-11" })], videoMinutesByDate: {}, losses: [] });
    expect(r.people).toEqual([]);
    expect(r.flags).toContainEqual({ kind: "counted_no_video", date: "2026-05-11", detail: expect.any(String) });
  });
  it("rejects a sub-3h deployment", () => {
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-02", start: "14:00", end: "16:30", deployMin: 150 })], videoMinutesByDate: { "2026-05-02": 9 }, losses: [] });
    expect(r.total).toBe(0);
  });
  it("adds 200 early at exactly 12:30 and 300 on a weekend", () => {
    // 2026-05-10 is a Sunday; arrival exactly 12:30.
    const r = computeBonuses({ period, reports: [rep({ flightDate: "2026-05-10", start: "12:30", end: "16:00", deployMin: 210 })], videoMinutesByDate: { "2026-05-10": 9 }, losses: [] });
    expect(r.people[0]).toMatchObject({ trips: 1, early: 1, weekend: 1, gross: 1200, net: 1200 });
  });
  it("applies −50% to a flight group with 2 losses in 12 trips", () => {
    const reports = Array.from({ length: 4 }, (_, i) => rep({ flightDate: `2026-05-0${i + 4}`, roster: ["Андріан", "Данило"] }));
    const video = Object.fromEntries(reports.map((r) => [r.flightDate, 9]));
    const r = computeBonuses({ period, reports, videoMinutesByDate: video, losses: [{ date: "2026-05-04", found: false, note: "x" }, { date: "2026-05-05", found: false, note: "y" }] });
    expect(r.people.find((p) => p.name === "Андріан")?.penaltyPct).toBe(0.5);
    expect(r.people.find((p) => p.name === "Андріан")?.net).toBe(700 * 4 * 0.5);
    expect(r.people.find((p) => p.name === "Данило")?.penaltyPct).toBe(0.5);
    expect(r.people.find((p) => p.name === "Данило")?.net).toBe(700 * 4 * 0.5);
  });
  it("a found drone is not a loss", () => {
    const reports = [rep({ flightDate: "2026-05-01" }), rep({ flightDate: "2026-05-02" })];
    const r = computeBonuses({ period, reports, videoMinutesByDate: { "2026-05-01": 9, "2026-05-02": 9 }, losses: [{ date: "2026-05-01", found: true, note: "found" }] });
    expect(r.people[0].penaltyPct).toBe(0);
  });
  it("zeroes everyone when the team loses >3 drones", () => {
    const reports = [rep({ flightDate: "2026-05-01" })];
    const losses = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"].map((d) => ({ date: d, found: false, note: "" }));
    const r = computeBonuses({ period, reports, videoMinutesByDate: { "2026-05-01": 9 }, losses });
    expect(r.teamZeroed).toBe(true);
    expect(r.total).toBe(0);
  });
  it("voids an otherwise-counted day with no drone-count report (that day, whole crew)", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-01", roster: ["Андріан", "Данило"] })],
      videoMinutesByDate: { "2026-05-01": 9 },
      losses: [],
      droneCountByDate: { "2026-05-01": false },
    });
    expect(r.people).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.days[0].reason).toBe("no-drone-count");
    expect(r.flags).toContainEqual({ kind: "no_drone_count", date: "2026-05-01", detail: expect.any(String) });
    expect(r.voidedDays).toEqual([{ date: "2026-05-01", roster: ["Андріан", "Данило"], reason: "no-drone-count" }]);
  });

  it("pays normally when the drone-count report is present", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-01" })],
      videoMinutesByDate: { "2026-05-01": 9 },
      losses: [],
      droneCountByDate: { "2026-05-01": true },
    });
    expect(r.total).toBe(700);
    expect(r.voidedDays).toEqual([]);
    expect(r.flags.find((f) => f.kind === "no_drone_count")).toBeUndefined();
  });

  it("keeps the hours reason (no drone-count flag) when the day already fails deploy<3h", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-02", start: "14:00", end: "16:30", deployMin: 150 })],
      videoMinutesByDate: { "2026-05-02": 9 },
      losses: [],
      droneCountByDate: {}, // present but missing this date
    });
    expect(r.days[0].reason).toBe("deploy<3h");
    expect(r.flags.find((f) => f.kind === "no_drone_count")).toBeUndefined();
    expect(r.voidedDays).toEqual([]);
  });

  it("leaves the gate disabled when droneCountByDate is omitted (backward compatible)", () => {
    const r = computeBonuses({
      period,
      reports: [rep({ flightDate: "2026-05-01" })],
      videoMinutesByDate: { "2026-05-01": 9 },
      losses: [],
    });
    expect(r.total).toBe(700);
    expect(r.voidedDays).toEqual([]);
  });
});

describe("roundVideoMin gate boundary", () => {
  it("rounds a raw value just under 2 up to 2.0", () => {
    expect(roundVideoMin(1.96)).toBe(2);
  });
  it("counts a day whose raw video rounds up to the 2-min gate when the drone-count report is present", () => {
    const r = computeBonuses({
      period: { start: "2026-05-01", end: "2026-05-31" },
      reports: [rep({ flightDate: "2026-05-01" })],
      videoMinutesByDate: { "2026-05-01": 1.96 },
      losses: [],
      droneCountByDate: { "2026-05-01": true },
    });
    expect(r.total).toBe(700);
    expect(r.voidedDays).toEqual([]);
  });
});

describe("computeBonuses with roster corrections", () => {
  const period = { start: "2026-06-01", end: "2026-06-30" };
  // One qualifying day (deploy ≥ 180m, video ≥ 2m): both crew get a trip.
  const reports = [
    rep({ flightDate: "2026-06-10", roster: ["Андріан", "Любомир"], start: "08:00", end: "12:00", deployMin: 240 }),
  ];
  const videoMinutesByDate = { "2026-06-10": 30 };

  it("uses a corrected crew", () => {
    const r = computeBonuses({ period, reports, videoMinutesByDate, losses: [], corrections: [{ date: "2026-06-10", roster: ["Тарас"], note: "n", by: "Oleksandr K", source: "s", recordedAt: "r" }] });
    expect(r.people.map((p) => p.name)).toEqual(["Тарас"]);
  });

  it("drops a person marked not_counted from the tally", () => {
    const r = computeBonuses({ period, reports, videoMinutesByDate, losses: [], corrections: [{ date: "2026-06-10", eligibility: { Любомир: "not_counted" }, note: "n", by: "Oleksandr K", source: "s", recordedAt: "r" }] });
    expect(r.people.map((p) => p.name)).toEqual(["Андріан"]);
  });

  it("works unchanged when no corrections are passed", () => {
    const r = computeBonuses({ period, reports, videoMinutesByDate, losses: [] });
    expect(r.people.map((p) => p.name).sort()).toEqual(["Андріан", "Любомир"]);
  });
});
