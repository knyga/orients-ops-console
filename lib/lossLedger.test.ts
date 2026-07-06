import { describe, expect, it } from "vitest";
import {
  effectiveLosses,
  lossForVerdict,
  unrecoveredLossDates,
  upsertWins,
  type LossRow,
} from "./lossLedger";

const row = (over: Partial<LossRow>): LossRow => ({
  date: "2026-07-04",
  reportTs: "111.222",
  lost: true,
  found: false,
  note: "втрата борта",
  source: "extracted",
  crashTextHash: "abc",
  updatedAt: "2026-07-06T00:00:00Z",
  updatedBy: null,
  ...over,
});

const JULY = { start: "2026-07-01", end: "2026-07-31" };

describe("upsertWins", () => {
  it("allows any write when no row exists", () => {
    expect(upsertWins(undefined, { source: "extracted" })).toBe(true);
    expect(upsertWins(undefined, { source: "instruction" })).toBe(true);
  });
  it("lets an instruction overwrite anything", () => {
    expect(upsertWins(row({ source: "extracted" }), { source: "instruction" })).toBe(true);
    expect(upsertWins(row({ source: "instruction" }), { source: "instruction" })).toBe(true);
  });
  it("never lets extraction overwrite an instruction", () => {
    expect(upsertWins(row({ source: "instruction" }), { source: "extracted" })).toBe(false);
    expect(upsertWins(row({ source: "extracted" }), { source: "extracted" })).toBe(true);
  });
});

describe("effectiveLosses / unrecoveredLossDates", () => {
  it("one entry per lost date; lost=false rows are invisible", () => {
    const rows = [row({}), row({ date: "2026-07-05", reportTs: "333.444" }), row({ date: "2026-07-03", reportTs: "555.6", lost: false })];
    expect(effectiveLosses(rows, JULY).map((l) => l.date)).toEqual(["2026-07-04", "2026-07-05"]);
    expect(unrecoveredLossDates(rows, JULY)).toEqual(["2026-07-04", "2026-07-05"]);
  });
  it("two same-date reports with losses dedupe to one date", () => {
    const rows = [row({}), row({ reportTs: "999.0" })];
    expect(unrecoveredLossDates(rows, JULY)).toEqual(["2026-07-04"]);
  });
  it("a per-report instruction row overrides the extracted row for the same reportTs", () => {
    const rows = [row({}), row({ source: "instruction", found: true, crashTextHash: null })];
    expect(unrecoveredLossDates(rows, JULY)).toEqual([]);
    expect(effectiveLosses(rows, JULY)).toEqual([{ date: "2026-07-04", found: true, note: "втрата борта" }]);
  });
  it("a day-wide instruction (reportTs '') overrides every report of the date", () => {
    const rows = [row({}), row({ reportTs: "999.0" }), row({ reportTs: "", source: "instruction", found: true, note: "знайшли" })];
    expect(unrecoveredLossDates(rows, JULY)).toEqual([]);
  });
  it("clamps to the period", () => {
    const rows = [row({ date: "2026-06-30" }), row({})];
    expect(unrecoveredLossDates(rows, JULY)).toEqual(["2026-07-04"]);
  });
});

describe("lossForVerdict", () => {
  it("returns the extracted state for the exact report", () => {
    expect(lossForVerdict([row({})], "2026-07-04", "111.222")).toEqual({ lost: true, found: false });
  });
  it("prefers a per-report instruction, then a day-wide instruction", () => {
    const rows = [row({}), row({ source: "instruction", found: true })];
    expect(lossForVerdict(rows, "2026-07-04", "111.222")).toEqual({ lost: true, found: true });
    const dayWide = [row({}), row({ reportTs: "", source: "instruction", found: true })];
    expect(lossForVerdict(dayWide, "2026-07-04", "111.222")).toEqual({ lost: true, found: true });
  });
  it("returns undefined when there is no loss (or lost=false)", () => {
    expect(lossForVerdict([row({ lost: false })], "2026-07-04", "111.222")).toBeUndefined();
    expect(lossForVerdict([], "2026-07-04", null)).toBeUndefined();
  });
});
