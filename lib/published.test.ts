import { describe, expect, it } from "vitest";
import { isPublished, recordPublished, type PublishedEntry, type PublishedLog } from "./published";

const entry = (over: Partial<PublishedEntry>): PublishedEntry => ({
  date: "2026-06-18",
  channel: "field-qa",
  text: "✅ 2026-06-18 — accepted",
  postedAt: "2026-06-20T00:00:00.000Z",
  ts: "1781969559.000100",
  ...over,
});

describe("isPublished / recordPublished (pure)", () => {
  it("recordPublished adds without mutating; isPublished detects the date", () => {
    const log: PublishedLog = {};
    const next = recordPublished(log, entry({}));
    expect(isPublished(log, "2026-06-18")).toBe(false); // original untouched
    expect(isPublished(next, "2026-06-18")).toBe(true);
    expect(isPublished(next, "2026-06-17")).toBe(false);
  });
});
