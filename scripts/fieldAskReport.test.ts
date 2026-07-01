import { describe, expect, it } from "vitest";
import { buildAskPlan, formatDryRun, parseArgs, pendingAsks, resolvePeriod } from "./fieldAskReport";
import type { DayVerdict } from "../lib/fieldDayVerdict";
import type { AskLog } from "../lib/asks";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-13",
  status: "NEEDS_REVIEW",
  airborneMinutes: 20,
  videoMinutes: 66,
  ratio: 3.3,
  datasetStatus: "MISSING",
  withinGrace: false,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
  ...over,
});

describe("parseArgs / resolvePeriod", () => {
  it("dry-run default; --publish flips", () => {
    expect(parseArgs([]).publish).toBe(false);
    expect(parseArgs(["--publish"]).publish).toBe(true);
  });
  it("defaults to current month", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-20")).toEqual({ start: "2026-06-01", end: "2026-06-20" });
  });
});

describe("buildAskPlan / pendingAsks", () => {
  it("flattens gaps across days and marks already-asked", () => {
    const days = [
      day({ date: "2026-06-13", ratio: 3.3, datasetStatus: "MISSING" }), // no_dataset
      day({ date: "2026-06-11", ratio: 0, videoMinutes: 0, datasetStatus: "POSTED" }), // low_video
      day({ date: "2026-06-10", status: "ACCEPTED" }), // no gaps
    ];
    const log: AskLog = {
      "no_dataset:2026-06-13": { gapType: "no_dataset", date: "2026-06-13", channel: "datasets", question: "q", state: "ASKED", askedTs: "1.1", askedAt: "2026-06-20T00:00:00Z" },
    };
    const plan = buildAskPlan(days, log);
    expect(plan.map((i) => i.key)).toEqual(["no_dataset:2026-06-13", "low_video:2026-06-11"]);
    expect(pendingAsks(plan).map((i) => i.key)).toEqual(["low_video:2026-06-11"]);
  });
});

describe("formatDryRun", () => {
  it("lists pending questions with channel + sends nothing", () => {
    const plan = buildAskPlan([day({ date: "2026-06-13", ratio: 3.3, datasetStatus: "MISSING" })], {});
    const out = formatDryRun(plan, { start: "2026-06-01", end: "2026-06-30" });
    expect(out).toMatch(/DRY RUN — would ask 1 question/);
    expect(out).toContain("#datasets");
    expect(out).toContain("No messages were sent");
  });
});
