import { describe, expect, it } from "vitest";
import { buildPlan, formatDryRun, parseArgs, pendingItems, resolvePeriod } from "./fieldPublishReport";
import type { DayVerdict } from "../lib/fieldDayVerdict";
import type { PublishedLog } from "../lib/published";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-18",
  reportTs: null,
  reportSeq: 1,
  reportCount: 1,
  status: "ACCEPTED",
  airborneMinutes: 18,
  videoMinutes: 206,
  ratio: 206 / 18,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
  ...over,
});

describe("parseArgs / resolvePeriod", () => {
  it("dry-run is the default; --publish flips it", () => {
    expect(parseArgs([]).publish).toBe(false);
    expect(parseArgs(["--publish"]).publish).toBe(true);
  });
  it("reads --channel and bounds", () => {
    const a = parseArgs(["--start", "2026-06-01", "--end", "2026-06-30", "--channel", "field-qa"]);
    expect(a.channel).toBe("field-qa");
    expect(resolvePeriod(a, "2026-06-20")).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
  it("defaults to the current month", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-20")).toEqual({ start: "2026-06-01", end: "2026-06-20" });
  });
});

describe("buildPlan / pendingItems", () => {
  it("includes settled days, marks already-published, excludes PENDING", () => {
    const days = [day({ date: "2026-06-18", status: "ACCEPTED" }), day({ date: "2026-06-17", status: "PENDING" }), day({ date: "2026-06-13", status: "NEEDS_REVIEW", reasons: ["x"] })];
    const log: PublishedLog = { "2026-06-18": { date: "2026-06-18", reportTs: null, channel: "field-qa", text: "...", postedAt: "2026-06-20T00:00:00Z", ts: "1.1" } };
    const plan = buildPlan(days, log);
    expect(plan.map((p) => p.date)).toEqual(["2026-06-18", "2026-06-13"]); // no PENDING
    expect(plan.find((p) => p.date === "2026-06-18")?.alreadyPublished).toBe(true);
    expect(pendingItems(plan).map((p) => p.date)).toEqual(["2026-06-13"]);
  });

  it("a legacy bare-date entry covers a single-report day (real reportTs, reportCount 1) but not either row of a 2-report day", () => {
    const days = [
      day({ date: "2026-07-01", status: "ACCEPTED", reportTs: "9.0", reportSeq: 1, reportCount: 1 }),
      day({ date: "2026-07-02", status: "ACCEPTED", reportTs: "1.0", reportSeq: 1, reportCount: 2 }),
      day({ date: "2026-07-02", status: "ACCEPTED", reportTs: "2.0", reportSeq: 2, reportCount: 2 }),
    ];
    const log: PublishedLog = {
      "2026-07-01": { date: "2026-07-01", reportTs: null, channel: "field-qa", text: "...", postedAt: "t", ts: "1.1" },
      "2026-07-02": { date: "2026-07-02", reportTs: null, channel: "field-qa", text: "...", postedAt: "t", ts: "2.1" },
    };
    const plan = buildPlan(days, log);
    expect(plan.find((p) => p.date === "2026-07-01")?.alreadyPublished).toBe(true);
    const julyTwo = plan.filter((p) => p.date === "2026-07-02");
    expect(julyTwo).toHaveLength(2);
    expect(julyTwo.every((p) => p.alreadyPublished === false)).toBe(true);
  });
});

describe("formatDryRun", () => {
  it("shows pending count, target channel, and the messages; sends nothing", () => {
    const plan = buildPlan([day({ date: "2026-06-13", status: "NEEDS_REVIEW", videoMinutes: 2, ratio: 0.1, datasetStatus: "MISSING", reasons: ["no #datasets notice for the day"] })], {});
    const out = formatDryRun(plan, "field-qa", { start: "2026-06-01", end: "2026-06-30" });
    expect(out).toMatch(/DRY RUN — would post 1 verdict\(s\) to #field-qa/);
    expect(out).toContain("потрібна перевірка");
    expect(out).toContain("No messages were sent");
  });

  it("notes when no channel is set", () => {
    const out = formatDryRun(buildPlan([day({})], {}), undefined, { start: "2026-06-01", end: "2026-06-30" });
    expect(out).toContain("no channel");
  });
});
