import { describe, it, expect } from "vitest";
import { parseArgs, parseArgs as parseBonusArgs, resolvePeriod, toCsv, formatTable, buildNotifyPlan, formatNotifyDryRun, buildRetractPlan, formatRetractDryRun } from "./fieldBonusReport";
import type { BonusReport } from "../lib/fieldBonus";
import type { DayBonus } from "../lib/fieldBonus";
import type { PublishedEntry } from "../lib/published";

const pub = (date: string, reportTs: string | null = null): PublishedEntry => ({
  date, reportTs, channel: "field-qa", text: "t", postedAt: "p", ts: `${date}-ts`,
});

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
    expect(resolvePeriod({ write: false, ask: false, publish: false, notify: false, retractThreads: false }, "2026-05-17")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
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
  voidedDays: [{ date: "2026-06-30", reportTs: null, roster: ["Влад", "Любомир"], reason: "deployment 120m is under 3h" }],
  pendingDays: [{ date: "2026-06-27", reportTs: null, roster: ["Андріан", "Сергій"], status: "NEEDS_REVIEW", reasons: ["no #datasets notice for the day"], amountAtStake: 2000 }],
};

describe("pending + voided surfaces", () => {
  it("toCsv appends a pending section", () => {
    const csv = toCsv(reportWithPendingAndVoided);
    expect(csv).toContain("pending,date,reportTs,status,roster,amountAtStake");
    expect(csv).toContain('pending,2026-06-27,,NEEDS_REVIEW,"Андріан, Сергій",2000');
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
  date: "2026-06-19", reportTs: null, reportCount: 1, roster: ["Андріан", "Тарас"], deployMin: 240, videoMin: 10,
  counted: true, early: false, weekend: false, reason: "counted", status: "ACCEPTED", ...over,
});

describe("notify flags + plan", () => {
  it("parses --notify and --channel", () => {
    const a = parseBonusArgs(["--notify", "--channel", "field-qa", "--publish"]);
    expect(a.notify).toBe(true);
    expect(a.channel).toBe("field-qa");
    expect(a.publish).toBe(true);
  });
  it("queues only matched, unsent DMs for a settled earned day (nothing for the thread)", () => {
    const plan = buildNotifyPlan({
      days: [day()],
      verdictByReport: new Map([["2026-06-19", "ACCEPTED"]]),
      published: { "2026-06-19": pub("2026-06-19") },
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", null]]),
      log: {},
    });
    expect(plan[0]).not.toHaveProperty("threadPending");
    expect(plan[0].pendingDms.map((t) => t.name)).toEqual(["Андріан"]);
    expect(plan[0].unmatched).toEqual(["Тарас"]);
  });
  it("skips a PENDING day entirely", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByReport: new Map([["2026-06-19", "PENDING"]]),
      published: { "2026-06-19": pub("2026-06-19") }, slackIdByName: new Map(), log: {},
    });
    expect(plan).toHaveLength(0);
  });
  // 2026-09-05: money is DM-only — a rejected day gets no in-thread «не
  // нараховано» note (the verdict message already says why), so it is not in
  // the plan at all.
  it("settled REJECTED day owes nothing — no thread note, no DMs — even when counted", () => {
    const plan = buildNotifyPlan({
      days: [day({ counted: true, reason: "counted" })],
      verdictByReport: new Map([["2026-06-19", "REJECTED"]]),
      published: { "2026-06-19": pub("2026-06-19") }, slackIdByName: new Map([["Андріан", "U1"], ["Тарас", "U2"]]), log: {},
    });
    expect(plan).toHaveLength(0);
  });
  it("skips a NEEDS_REVIEW day (not final)", () => {
    const plan = buildNotifyPlan({
      days: [day({ counted: true })],
      verdictByReport: new Map([["2026-06-19", "NEEDS_REVIEW"]]),
      published: { "2026-06-19": pub("2026-06-19") }, slackIdByName: new Map(), log: {},
    });
    expect(plan).toHaveLength(0);
  });
  it("skips an already DMed day (a legacy thread_ts neither adds nor blocks anything)", () => {
    const dms = [{ slackId: "U1", ts: "2.2", amount: 700 }, { slackId: "U2", ts: "3.3", amount: 700 }];
    for (const threadTs of ["1.1", undefined]) {
      const plan = buildNotifyPlan({
        days: [day()], verdictByReport: new Map([["2026-06-19", "ACCEPTED"]]),
        published: { "2026-06-19": pub("2026-06-19") },
        slackIdByName: new Map([["Андріан", "U1"], ["Тарас", "U2"]]),
        log: { "2026-06-19": { date: "2026-06-19", reportTs: null, threadTs, dms } },
      });
      expect(plan).toHaveLength(0);
    }
  });
  it("flags an unpublished day (cannot reply in a missing thread)", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByReport: new Map([["2026-06-19", "ACCEPTED"]]),
      published: {}, slackIdByName: new Map([["Андріан", "U1"]]), log: {},
    });
    expect(plan[0].published).toBe(false);
  });
  it("dry-run names the date and says nothing is sent", () => {
    const plan = buildNotifyPlan({
      days: [day()], verdictByReport: new Map([["2026-06-19", "ACCEPTED"]]),
      published: { "2026-06-19": pub("2026-06-19") }, slackIdByName: new Map([["Андріан", "U1"], ["Тарас", null]]), log: {},
    });
    const out = formatNotifyDryRun(plan);
    expect(out).toContain("2026-06-19");
    expect(out).toContain("DRY RUN");
    expect(out).toContain("DM-only");
    expect(out).not.toContain("thread message");
  });
  it("resolves a two-report day independently — each report's own verdict/notified state", () => {
    const days = [
      day({ reportTs: "1.0", reportCount: 2, roster: ["Андріан"] }),
      day({ reportTs: "2.0", reportCount: 2, roster: ["Тарас"], status: "REJECTED", counted: false, reason: "REJECTED" }),
    ];
    const plan = buildNotifyPlan({
      days,
      verdictByReport: new Map([["2026-06-19#1.0", "ACCEPTED"], ["2026-06-19#2.0", "REJECTED"]]),
      published: { "2026-06-19#1.0": pub("2026-06-19", "1.0"), "2026-06-19#2.0": pub("2026-06-19", "2.0") },
      slackIdByName: new Map([["Андріан", "U1"], ["Тарас", "U2"]]),
      log: {},
    });
    // only the accepted report owes a DM; the rejected one owes nothing
    expect(plan.map((p) => p.reportTs)).toEqual(["1.0"]);
    expect(plan[0].earned).toBe(true);
  });

  it("retract plan lists only entries that still carry a thread post", () => {
    expect(parseBonusArgs(["--retract-threads", "--publish", "--channel", "field-qa"]).retractThreads).toBe(true);
    expect(parseBonusArgs(["--notify"]).retractThreads).toBe(false);
    const plan = buildRetractPlan({
      "2026-08-30#1.0": { date: "2026-08-30", reportTs: "1.0", threadTs: "9.9", dms: [] },
      "2026-08-29#2.0": { date: "2026-08-29", reportTs: "2.0", dms: [{ slackId: "U1", ts: "3.3", amount: 700 }] },
    });
    expect(plan).toEqual([{ key: "2026-08-30#1.0", date: "2026-08-30", threadTs: "9.9" }]);
    const out = formatRetractDryRun(plan, "field-qa");
    expect(out).toContain("DRY RUN");
    expect(out).toContain("1 in-thread bonus message(s) in #field-qa");
    expect(out).toContain("2026-08-30#1.0");
  });
});
