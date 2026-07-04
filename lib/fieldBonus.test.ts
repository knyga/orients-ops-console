import { describe, it, expect } from "vitest";
import { computeBonuses, TRIP, EARLY, WEEKEND, type QualifiedDay } from "./fieldBonus";

const PERIOD = { start: "2026-06-01", end: "2026-06-30" };
const qd = (over: Partial<QualifiedDay>): QualifiedDay => ({
  date: "2026-06-02", status: "ACCEPTED", roster: ["Андріан", "Надія"], unknownInitials: [],
  deployMin: 270, videoMin: 44.8, start: "13:00", reasons: [], flew: true, ...over,
});

describe("status-driven pay", () => {
  it("pays ACCEPTED and ACCEPTED_EXCEPTION days only", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({}),                                                        // pays
      qd({ date: "2026-06-21", status: "ACCEPTED_EXCEPTION", roster: ["Андріан", "Сергій"] }), // pays (Sunday)
      qd({ date: "2026-06-27", status: "NEEDS_REVIEW", reasons: ["no #datasets notice for the day"] }),
      qd({ date: "2026-06-30", status: "REJECTED", deployMin: 120, reasons: ["deployment 120m is under 3h"], roster: ["Влад", "Любомир"] }),
    ]});
    const andrian = r.people.find((p) => p.name === "Андріан")!;
    expect(andrian.trips).toBe(2);
    expect(andrian.weekend).toBe(1); // 06-21 is a Sunday
    expect(r.people.find((p) => p.name === "Влад")).toBeUndefined();
  });

  it("collects unsettled flown days into pendingDays with the amount at stake", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({ date: "2026-06-27", status: "NEEDS_REVIEW", roster: ["Андріан", "Сергій"], reasons: ["no #datasets notice for the day"] }),
    ]});
    expect(r.pendingDays).toEqual([{
      date: "2026-06-27", roster: ["Андріан", "Сергій"], status: "NEEDS_REVIEW",
      reasons: ["no #datasets notice for the day"],
      amountAtStake: 2 * (TRIP + WEEKEND), // 06-27 is a Saturday
    }]);
    expect(r.total).toBe(0);
  });

  it("does not list no-fly review days as pending", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({ date: "2026-06-07", status: "NEEDS_REVIEW", flew: false, roster: [] }),
    ]});
    expect(r.pendingDays).toHaveLength(0);
  });

  it("REJECTED days land in voidedDays with the verdict reason", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({ date: "2026-06-30", status: "REJECTED", reasons: ["deployment 120m is under 3h"], roster: ["Влад", "Любомир"] }),
    ]});
    expect(r.voidedDays).toEqual([{ date: "2026-06-30", roster: ["Влад", "Любомир"], reason: "deployment 120m is under 3h" }]);
  });

  it("early bonus still keys off the Звіт start time", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [qd({ start: "07:30" })] });
    expect(r.people[0].early).toBe(1);
    expect(r.people[0].gross).toBe(TRIP + EARLY);
  });
});

describe("computeBonuses loss/penalty/team-zero (adapted to QualifiedDay)", () => {
  const period = { start: "2026-05-01", end: "2026-05-31" };
  const qday = (over: Partial<QualifiedDay>): QualifiedDay => ({
    date: "2026-05-01", status: "ACCEPTED", roster: ["Андріан"], unknownInitials: [],
    deployMin: 180, videoMin: 9, start: "14:00", reasons: [], flew: true, ...over,
  });

  it("pays 700 for a qualifying weekday trip", () => {
    const r = computeBonuses({ period, losses: [], days: [qday({ date: "2026-05-01", videoMin: 5 })] });
    expect(r.people).toEqual([{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }]);
    expect(r.total).toBe(700);
  });

  it("adds 200 early at exactly 12:30 and 300 on a weekend", () => {
    // 2026-05-10 is a Sunday; arrival exactly 12:30.
    const r = computeBonuses({ period, losses: [], days: [qday({ date: "2026-05-10", start: "12:30", deployMin: 210 })] });
    expect(r.people[0]).toMatchObject({ trips: 1, early: 1, weekend: 1, gross: 1200, net: 1200 });
  });

  it("applies −50% to a flight group with 2 losses in 12 trips", () => {
    const days = Array.from({ length: 4 }, (_, i) => qday({ date: `2026-05-0${i + 4}`, roster: ["Андріан", "Данило"] }));
    const r = computeBonuses({ period, days, losses: [{ date: "2026-05-04", found: false, note: "x" }, { date: "2026-05-05", found: false, note: "y" }] });
    expect(r.people.find((p) => p.name === "Андріан")?.penaltyPct).toBe(0.5);
    expect(r.people.find((p) => p.name === "Андріан")?.net).toBe(700 * 4 * 0.5);
    expect(r.people.find((p) => p.name === "Данило")?.penaltyPct).toBe(0.5);
    expect(r.people.find((p) => p.name === "Данило")?.net).toBe(700 * 4 * 0.5);
  });

  it("a found drone is not a loss", () => {
    const days = [qday({ date: "2026-05-01" }), qday({ date: "2026-05-02" })];
    const r = computeBonuses({ period, days, losses: [{ date: "2026-05-01", found: true, note: "found" }] });
    expect(r.people[0].penaltyPct).toBe(0);
  });

  it("zeroes everyone when the team loses >3 drones", () => {
    const days = [qday({ date: "2026-05-01" })];
    const losses = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"].map((d) => ({ date: d, found: false, note: "" }));
    const r = computeBonuses({ period, days, losses });
    expect(r.teamZeroed).toBe(true);
    expect(r.total).toBe(0);
  });
});

describe("computeBonuses with roster corrections", () => {
  const period = { start: "2026-06-01", end: "2026-06-30" };
  // One qualifying day (ACCEPTED verdict): both crew get a trip.
  const days: QualifiedDay[] = [
    { date: "2026-06-10", status: "ACCEPTED", roster: ["Андріан", "Любомир"], unknownInitials: [], deployMin: 240, videoMin: 30, start: "08:00", reasons: [], flew: true },
  ];

  it("uses a corrected crew", () => {
    const r = computeBonuses({ period, days, losses: [], corrections: [{ date: "2026-06-10", roster: ["Тарас"], note: "n", by: "Oleksandr K", source: "s", recordedAt: "r" }] });
    expect(r.people.map((p) => p.name)).toEqual(["Тарас"]);
  });

  it("drops a person marked not_counted from the tally", () => {
    const r = computeBonuses({ period, days, losses: [], corrections: [{ date: "2026-06-10", eligibility: { Любомир: "not_counted" }, note: "n", by: "Oleksandr K", source: "s", recordedAt: "r" }] });
    expect(r.people.map((p) => p.name)).toEqual(["Андріан"]);
  });

  it("works unchanged when no corrections are passed", () => {
    const r = computeBonuses({ period, days, losses: [] });
    expect(r.people.map((p) => p.name).sort()).toEqual(["Андріан", "Любомир"]);
  });
});
