import { describe, expect, it } from "vitest";
import { mergeMessages, monthsInPeriod, upsertMessages, type StoredMessage } from "./slackMirror";

// Build a StoredMessage with sensible defaults for the field under test.
const stored = (over: Partial<StoredMessage>): StoredMessage => ({
  ts: "1716200000.000200",
  channel: "field-qa",
  authorId: "U1",
  author: "Pilot",
  isoTime: "2026-06-10T09:00:00.000Z",
  text: "hello",
  permalink: "https://x.slack.com/p1",
  firstSeen: "2026-06-10T09:05:00.000Z",
  lastSeen: "2026-06-10T09:05:00.000Z",
  ...over,
});

describe("period helpers", () => {
  it("monthsInPeriod returns the distinct YYYY-MM set a period spans", () => {
    expect(monthsInPeriod({ start: "2026-05-28", end: "2026-07-02" })).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
    expect(monthsInPeriod({ start: "2026-06-01", end: "2026-06-30" })).toEqual([
      "2026-06",
    ]);
  });
});

describe("upsertMessages", () => {
  it("inserts a new message with its firstSeen/lastSeen", () => {
    const now = "2026-06-11T00:00:00.000Z";
    const fresh = stored({ ts: "1.1", firstSeen: now, lastSeen: now });
    const result = upsertMessages({}, [fresh], now);
    expect(result["1.1"].firstSeen).toBe(now);
    expect(result["1.1"].lastSeen).toBe(now);
    expect(result["1.1"].text).toBe("hello");
  });

  it("preserves firstSeen but refreshes text/edited/lastSeen on re-fetch", () => {
    const existing = {
      "1.1": stored({ ts: "1.1", text: "old", firstSeen: "2026-06-10T09:05:00.000Z" }),
    };
    const now = "2026-06-12T00:00:00.000Z";
    const edited = stored({ ts: "1.1", text: "new", edited: "1716300000.000000", firstSeen: now, lastSeen: now });
    const result = upsertMessages(existing, [edited], now);
    expect(result["1.1"].text).toBe("new");
    expect(result["1.1"].edited).toBe("1716300000.000000");
    expect(result["1.1"].firstSeen).toBe("2026-06-10T09:05:00.000Z"); // preserved
    expect(result["1.1"].lastSeen).toBe(now);
  });

  it("clears a stale deleted flag when a tombstoned message reappears", () => {
    const existing = { "1.1": stored({ ts: "1.1", deleted: true }) };
    const now = "2026-06-12T00:00:00.000Z";
    const result = upsertMessages(existing, [stored({ ts: "1.1", firstSeen: now, lastSeen: now })], now);
    expect(result["1.1"].deleted).toBeUndefined();
  });

  it("omits absent optional fields rather than setting them to undefined", () => {
    const now = "2026-06-11T00:00:00.000Z";
    // stored() helper sets no files/thread_ts/edited by default
    const result = upsertMessages({}, [stored({ ts: "1.1", firstSeen: now, lastSeen: now })], now);
    expect("files" in result["1.1"]).toBe(false);
    expect("thread_ts" in result["1.1"]).toBe(false);
    expect("edited" in result["1.1"]).toBe(false);
  });
});

describe("mergeMessages (upsert + tombstone)", () => {
  const windowStart = "2026-06-08T00:00:00.000Z";
  const now = "2026-06-12T00:00:00.000Z";

  it("tombstones a stored message inside the window that is absent from the fetch", () => {
    const existing = { "1.1": stored({ ts: "1.1", isoTime: "2026-06-10T09:00:00.000Z" }) };
    const result = mergeMessages(existing, [], windowStart, now);
    expect(result["1.1"].deleted).toBe(true);
  });

  it("never tombstones a stored message OUTSIDE the window", () => {
    const existing = { "1.1": stored({ ts: "1.1", isoTime: "2026-05-01T09:00:00.000Z" }) };
    const result = mergeMessages(existing, [], windowStart, now);
    expect(result["1.1"].deleted).toBeUndefined();
  });

  it("keeps a still-present message un-tombstoned and upserts replies independently", () => {
    const parent = stored({ ts: "1.1", isoTime: "2026-06-10T09:00:00.000Z", thread_ts: "1.1", reply_count: 1, firstSeen: now, lastSeen: now });
    const reply = stored({ ts: "1.2", isoTime: "2026-06-10T10:00:00.000Z", thread_ts: "1.1", firstSeen: now, lastSeen: now });
    const result = mergeMessages({}, [parent, reply], windowStart, now);
    expect(result["1.1"].deleted).toBeUndefined();
    expect(result["1.2"].thread_ts).toBe("1.1");
    expect(Object.keys(result)).toHaveLength(2);
  });

  it("tombstones a message exactly at windowStart and exactly at now (inclusive bounds)", () => {
    const existing = {
      "a": stored({ ts: "a", isoTime: windowStart }),
      "b": stored({ ts: "b", isoTime: now }),
    };
    const result = mergeMessages(existing, [], windowStart, now);
    expect(result["a"].deleted).toBe(true);
    expect(result["b"].deleted).toBe(true);
  });
});
