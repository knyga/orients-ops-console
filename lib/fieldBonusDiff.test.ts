import { describe, it, expect } from "vitest";
import { diffAgainstSheet } from "./fieldBonusDiff";
import type { BonusReport } from "./fieldBonus";

const report = { people: [{ name: "Андріан", trips: 14, early: 9, weekend: 3, gross: 0, penaltyPct: 0, net: 0 }] } as unknown as BonusReport;

describe("diffAgainstSheet", () => {
  it("flags a weekend-count divergence", () => {
    const out = diffAgainstSheet(report, { Андріан: { trips: 14, early: 9, weekend: 4 } });
    expect(out).toContainEqual({ name: "Андріан", field: "weekend", ours: 3, theirs: 4 });
  });
  it("is empty when everything matches", () => {
    expect(diffAgainstSheet(report, { Андріан: { trips: 14, early: 9, weekend: 3 } })).toEqual([]);
  });
});
