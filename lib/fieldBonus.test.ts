import { describe, it, expect } from "vitest";
import { computeBonuses } from "./fieldBonus";
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
});
