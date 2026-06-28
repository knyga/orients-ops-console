import { describe, it, expect } from "vitest";
import { dayPersonBonuses, dayTotal, formatThreadBreakdown, formatDm, formatNoBonusNote, type PersonAmount } from "./bonusNotify";
import type { DayBonus } from "./fieldBonus";

const counted = (over: Partial<DayBonus> = {}): DayBonus => ({
  date: "2026-06-19", roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", ...over,
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
