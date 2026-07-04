import { describe, expect, it } from "vitest";
import { isPublished, recordPublished, type PublishedEntry, type PublishedLog } from "./published";

const entry = (date: string, reportTs: string | null): PublishedEntry => ({
  date,
  reportTs,
  channel: "field-qa",
  text: "t",
  postedAt: "p",
  ts: `${date}-ts`,
});

describe("isPublished / recordPublished (pure)", () => {
  it("recordPublished adds without mutating; isPublished detects the date", () => {
    const log: PublishedLog = {};
    const next = recordPublished(log, entry("2026-06-18", null));
    expect(isPublished(log, { date: "2026-06-18", reportTs: null, reportCount: 1 })).toBe(false); // original untouched
    expect(isPublished(next, { date: "2026-06-18", reportTs: null, reportCount: 1 })).toBe(true);
    expect(isPublished(next, { date: "2026-06-17", reportTs: null, reportCount: 1 })).toBe(false);
  });

  it("records per-report entries under date#ts without colliding", () => {
    let log: PublishedLog = {};
    log = recordPublished(log, entry("2026-07-01", "1.0"));
    log = recordPublished(log, entry("2026-07-01", "2.0"));
    expect(Object.keys(log).sort()).toEqual(["2026-07-01#1.0", "2026-07-01#2.0"]);
  });

  it("isPublished: exact key, legacy bare-date fallback only for single-report days", () => {
    const legacy: PublishedLog = { "2026-06-29": entry("2026-06-29", null) };
    expect(isPublished(legacy, { date: "2026-06-29", reportTs: "9.0", reportCount: 1 })).toBe(true);
    expect(isPublished(legacy, { date: "2026-06-29", reportTs: null, reportCount: 1 })).toBe(true);
    // 07-01 conflict: a legacy day entry does NOT cover a multi-report day's reports
    const conflicted: PublishedLog = { "2026-07-01": entry("2026-07-01", null) };
    expect(isPublished(conflicted, { date: "2026-07-01", reportTs: "1.0", reportCount: 2 })).toBe(false);
  });
});
