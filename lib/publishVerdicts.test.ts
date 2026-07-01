import { describe, it, expect, vi, beforeEach } from "vitest";

const { postMessage, readPublished, writePublished } = vi.hoisted(() => ({
  postMessage: vi.fn(),
  readPublished: vi.fn(),
  writePublished: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readPublished, writePublished };
});

import { publishSettledDays } from "./publishVerdicts";
import type { DayVerdict } from "./fieldDayVerdict";

const channel = { id: "C08GY2NKF9D", name: "field-qa" };
const period = { start: "2026-06-01", end: "2026-06-30" };

// Minimal settled ACCEPTED day, type-valid against lib/fieldDayVerdict.
const day = (date: string): DayVerdict => ({
  date,
  status: "ACCEPTED",
  airborneMinutes: 20,
  videoMinutes: 40,
  ratio: 2,
  datasetStatus: "POSTED",
  withinGrace: true,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
});

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("1782900000.000100");
  readPublished.mockReset();
  writePublished.mockReset().mockResolvedValue(undefined);
});

describe("publishSettledDays", () => {
  it("posts each unpublished settled day and records it", async () => {
    readPublished.mockResolvedValue({}); // flat Record<date, entry> — empty log
    const res = await publishSettledDays([day("2026-06-29"), day("2026-06-30")], channel, period);
    expect(res.posted).toEqual(["2026-06-29", "2026-06-30"]);
    expect(res.skipped).toEqual([]);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(writePublished).toHaveBeenCalledTimes(2); // persisted after each post
  });

  it("skips days already in the published log (idempotent)", async () => {
    readPublished.mockResolvedValue({
      "2026-06-29": { date: "2026-06-29", channel: "field-qa", text: "x", postedAt: "t", ts: "x" },
    });
    const res = await publishSettledDays([day("2026-06-29"), day("2026-06-30")], channel, period);
    expect(res.posted).toEqual(["2026-06-30"]);
    expect(res.skipped).toEqual(["2026-06-29"]);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
