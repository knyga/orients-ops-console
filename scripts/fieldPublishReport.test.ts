import { describe, expect, it } from "vitest";
import { buildPlan, formatDryRun, parseArgs, pendingItems, resolvePeriod } from "./fieldPublishReport";
import type { DayVerdict } from "../lib/fieldDayVerdict";
import type { PublishedLog } from "../lib/published";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-18",
  status: "ACCEPTED",
  airborneMinutes: 18,
  videoMinutes: 206,
  ratio: 206 / 18,
  datasetPosted: true,
  withinGrace: false,
  reasons: [],
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
    const log: PublishedLog = { "2026-06-18": { date: "2026-06-18", channel: "field-qa", text: "...", postedAt: "2026-06-20T00:00:00Z", ts: "1.1" } };
    const plan = buildPlan(days, log);
    expect(plan.map((p) => p.date)).toEqual(["2026-06-18", "2026-06-13"]); // no PENDING
    expect(plan.find((p) => p.date === "2026-06-18")?.alreadyPublished).toBe(true);
    expect(pendingItems(plan).map((p) => p.date)).toEqual(["2026-06-13"]);
  });
});

describe("formatDryRun", () => {
  it("shows pending count, target channel, and the messages; sends nothing", () => {
    const plan = buildPlan([day({ date: "2026-06-13", status: "NEEDS_REVIEW", videoMinutes: 2, ratio: 0.1, datasetPosted: false, reasons: ["no #datasets notice for the day"] })], {});
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
