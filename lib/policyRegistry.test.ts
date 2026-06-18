import { describe, expect, it } from "vitest";
import { activeObligations, OBLIGATIONS, type Obligation } from "./policyRegistry";

const ob = (over: Partial<Obligation>): Obligation => ({
  id: "x",
  title: "X",
  description: "",
  channel: "budgets",
  responsible: [],
  cadence: { type: "weekly", weekday: 1 },
  gracePeriodWorkingDays: 0,
  effectiveFrom: "2026-01-01",
  ...over,
});

describe("activeObligations", () => {
  it("includes an obligation whose effective range overlaps the period", () => {
    const list = [ob({ id: "a", effectiveFrom: "2026-03-01" })];
    expect(activeObligations({ start: "2026-03-01", end: "2026-03-31" }, list).map((o) => o.id)).toEqual(["a"]);
  });

  it("excludes an obligation effective only after the period", () => {
    const list = [ob({ id: "a", effectiveFrom: "2026-05-01" })];
    expect(activeObligations({ start: "2026-03-01", end: "2026-03-31" }, list)).toEqual([]);
  });

  it("excludes an obligation whose effectiveTo ends before the period", () => {
    const list = [ob({ id: "a", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-28" })];
    expect(activeObligations({ start: "2026-03-01", end: "2026-03-31" }, list)).toEqual([]);
  });

  it("defaults to the committed OBLIGATIONS and yields a non-empty list for a recent month", () => {
    expect(activeObligations({ start: "2026-05-01", end: "2026-05-31" }).length).toBeGreaterThan(0);
  });
});
