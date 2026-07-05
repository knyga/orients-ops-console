import { describe, it, expect } from "vitest";
import { dayPersonBonuses, dayTotal, formatThreadBreakdown, formatDm, formatNoBonusNote, type PersonAmount } from "./bonusNotify";
import type { DayBonus } from "./fieldBonus";

const counted = (over: Partial<DayBonus> = {}): DayBonus => ({
  date: "2026-06-19", reportTs: null, reportCount: 1, roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", status: "ACCEPTED", ...over,
});

describe("dayPersonBonuses", () => {
  it("pays base per roster member on a counted day", () => {
    expect(dayPersonBonuses(counted())).toEqual([
      { name: "Андріан", base: 700, early: 0, weekend: 0, total: 700 },
      { name: "Тарас", base: 700, early: 0, weekend: 0, total: 700 },
    ]);
  });
  it("stacks early + weekend", () => {
    const p = dayPersonBonuses(counted({ early: true, weekend: true }))[0];
    expect(p).toMatchObject({ base: 700, early: 200, weekend: 300, total: 1200 });
  });
  it("returns [] for a non-counted day", () => {
    expect(dayPersonBonuses(counted({ counted: false, reason: "deploy<3h" }))).toEqual([]);
  });
  it("scales by splitFactor with components summing to the total", () => {
    // 3-person Saturday: pot 2×(700+300), each round(1000·⅔) = 667.
    const people = dayPersonBonuses(counted({ roster: ["Андріан", "Сергій", "Данило"], weekend: true, splitFactor: 2 / 3 }));
    expect(people).toHaveLength(3);
    for (const p of people) {
      expect(p.total).toBe(667);
      expect(p.base + p.early + p.weekend).toBe(p.total);
      expect(p.weekend).toBe(200); // round(300·⅔)
    }
  });
  it("pays only the paidRoster when eligibility excluded someone", () => {
    const people = dayPersonBonuses(counted({ roster: ["Андріан", "Сергій", "Данило"], paidRoster: ["Андріан", "Сергій"] }));
    expect(people.map((p) => p.name)).toEqual(["Андріан", "Сергій"]);
    expect(people[0].total).toBe(700);
  });
  it("defaults to full pay for old committed days without the split fields", () => {
    const people = dayPersonBonuses(counted({ roster: ["А", "Б", "В"] }));
    expect(people.map((p) => p.total)).toEqual([700, 700, 700]);
  });
});

describe("messages", () => {
  const people: PersonAmount[] = [
    { name: "Андріан", base: 700, early: 200, weekend: 0, total: 900 },
    { name: "Тарас", base: 700, early: 0, weekend: 0, total: 700 },
  ];
  it("thread breakdown lists people, the total, and the provisional caveat", () => {
    const t = formatThreadBreakdown("2026-06-19", people);
    expect(t).toContain("Андріан");
    expect(t).toContain("900");
    expect(t).toContain(String(dayTotal(people))); // 1600
    expect(t).toContain("попередн"); // provisional
  });
  it("DM shows only the recipient + finance pointer, not other names", () => {
    const dm = formatDm("2026-06-19", people[0]);
    expect(dm).toContain("900");
    expect(dm).not.toContain("Тарас");
    expect(dm).toContain("Марин");
  });
  it("no-bonus note carries the reason", () => {
    expect(formatNoBonusNote("2026-06-19", "deploy<3h")).toContain("deploy<3h");
  });
});
