import { describe, it, expect } from "vitest";
import { parseArgs, parseArgs as parseBonusArgs, resolvePeriod, toCsv, formatTable, buildNotifyPlan, formatNotifyDryRun } from "./fieldBonusReport";
import type { BonusReport } from "../lib/fieldBonus";
import type { DayBonus } from "../lib/fieldBonus";

const report: BonusReport = {
  period: { start: "2026-05-01", end: "2026-05-31" }, days: [], penalties: [], voidedDays: [], teamZeroed: false, flags: [], total: 700,
  people: [{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }],
  pendingDays: [],
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

const reportWithPendingAndVoided: BonusReport = {
  period: { start: "2026-06-01", end: "2026-06-30" },
  days: [], people: [{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }],
  penalties: [], teamZeroed: false, flags: [], total: 700,
  voidedDays: [{ date: "2026-06-30", roster: ["Влад", "Любомир"], reason: "deployment 120m is under 3h" }],
  pendingDays: [{ date: "2026-06-27", roster: ["Андріан", "Сергій"], status: "NEEDS_REVIEW", reasons: ["no #datasets notice for the day"], amountAtStake: 2000 }],
};

describe("pending + voided surfaces", () => {
  it("toCsv appends a pending section", () => {
    const csv = toCsv(reportWithPendingAndVoided);
    expect(csv).toContain("pending,date,status,roster,amountAtStake");
    expect(csv).toContain('pending,2026-06-27,NEEDS_REVIEW,"Андріан, Сергій",2000');
  });

  it("formatTable prints pending and voided days", () => {
    const t = formatTable(reportWithPendingAndVoided);
    expect(t).toContain("Pending review:");
    expect(t).toContain("2026-06-27  NEEDS_REVIEW  Андріан, Сергій — ₴2000 at stake");
    expect(t).toContain("Voided (rejected):");
    expect(t).toContain("2026-06-30  Влад, Любомир — deployment 120m is under 3h");
  });
});

const day = (over: Partial<DayBonus> = {}): DayBonus => ({
  date: "2026-06-19", roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", status: "ACCEPTED", ...over,
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
  it("settled REJECTED day earns nothing (no-bonus note, no DMs) even when counted", () => {
    const plan = buildNotifyPlan({
      days: [day({ counted: true, reason: "counted" })],
      verdictByDate: new Map([["2026-06-19", "REJECTED"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map(), log: {},
    });
    expect(plan[0].earned).toBe(false);
    expect(plan[0].threadPending).toBe(true);
    expect(plan[0].pendingDms).toHaveLength(0);
    expect(plan[0].reason).toBe("виїзд відхилено");
  });
  it("skips a NEEDS_REVIEW day (not final)", () => {
    const plan = buildNotifyPlan({
      days: [day({ counted: true })],
      verdictByDate: new Map([["2026-06-19", "NEEDS_REVIEW"]]),
      publishedDates: new Set(["2026-06-19"]), slackIdByName: new Map(), log: {},
    });
    expect(plan).toHaveLength(0);
  });
  it("skips an already thread-notified + DMed day", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByDate: new Map([["2026-06-19", "ACCEPTED"]]),
      publishedDates: new Set(["2026-06-19"]),
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", "U2"]]),
      log: { "2026-06-19": { date: "2026-06-19", threadTs: "1.1", dms: [{ slackId: "U1", ts: "2.2", amount: 700 }, { slackId: "U2", ts: "3.3", amount: 700 }] } },
    });
    expect(plan).toHaveLength(0);
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
