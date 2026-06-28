import { describe, it, expect } from "vitest";
import { parseArgs, parseArgs as parseBonusArgs, resolvePeriod, toCsv, buildNotifyPlan, formatNotifyDryRun } from "./fieldBonusReport";
import type { BonusReport } from "../lib/fieldBonus";
import type { DayBonus } from "../lib/fieldBonus";

const report: BonusReport = {
  period: { start: "2026-05-01", end: "2026-05-31" }, days: [], penalties: [], teamZeroed: false, flags: [], total: 700,
  people: [{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }],
};

describe("fieldBonusReport", () => {
  it("parses flags", () => {
    expect(parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--write", "--format", "table"]))
      .toMatchObject({ start: "2026-05-01", end: "2026-05-31", write: true, format: "table" });
  });
  it("defaults the period to the current Kyiv month", () => {
    expect(resolvePeriod({ write: false, ask: false, publish: false, notify: false }, "2026-05-17")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });
  it("emits a per-person CSV header + rows", () => {
    expect(toCsv(report).split("\n")[0]).toBe("person,trips,early,weekend,gross,penaltyPct,net");
    expect(toCsv(report)).toContain("Андріан,1,0,0,700,0,700");
  });
});

const day = (over: Partial<DayBonus> = {}): DayBonus => ({
  date: "2026-06-19", roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", ...over,
});

describe("notify flags + plan", () => {
  it("parses --notify and --channel", () => {
    const a = parseBonusArgs(["--notify", "--channel", "field-qa", "--publish"]);
    expect(a.notify).toBe(true);
    expect(a.channel).toBe("field-qa");
    expect(a.publish).toBe(true);
  });
  it("queues a thread + only matched, unsent DMs for a settled earned day", () => {
    const plan = buildNotifyPlan({
      days: [day()],
      verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]),
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", null]]),
      log: {},
    });
    expect(plan[0].threadPending).toBe(true);
    expect(plan[0].pendingDms.map((t) => t.name)).toEqual(["Андріан"]);
    expect(plan[0].unmatched).toEqual(["Тарас"]);
  });
  it("skips a PENDING day entirely", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "PENDING"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map(), log: {},
    });
    expect(plan).toHaveLength(0);
  });
  it("marks a non-counted settled day as no-bonus (thread note, no DMs)", () => {
    const plan = buildNotifyPlan({
      days: [day({ counted: false, reason: "deploy<3h" })],
      verdictByDate: new Map([["2026-06-19", "NEEDS_REVIEW"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map(), log: {},
    });
    expect(plan[0].earned).toBe(false);
    expect(plan[0].threadPending).toBe(true);
    expect(plan[0].pendingDms).toHaveLength(0);
  });
  it("skips an already thread-notified + DMed day", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]),
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", "U2"]]),
      log: { "2026-06-19": { date: "2026-06-19", threadTs: "1.1", dms: [{ slackId: "U1", ts: "2.2", amount: 700 }, { slackId: "U2", ts: "3.3", amount: 700 }] } },
    });
    expect(plan[0].threadPending).toBe(false);
    expect(plan[0].pendingDms).toHaveLength(0);
  });
  it("flags an unpublished day (cannot reply in a missing thread)", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(), slackIdByName: new Map([["Андріан", "U1"]]), log: {},
    });
    expect(plan[0].published).toBe(false);
  });
  it("dry-run names the date and says nothing is sent", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map([["Андріан", "U1"], ["Тарас", null]]), log: {},
    });
    const out = formatNotifyDryRun(plan, "field-qa");
    expect(out).toContain("2026-06-19");
    expect(out).toContain("DRY RUN");
  });
});
