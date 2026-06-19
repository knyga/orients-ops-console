import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeMessages,
  monthFilePath,
  monthsInPeriod,
  readMonthFile,
  readSyncCursor,
  syncFilePath,
  upsertMessages,
  writeMonthFile,
  writeSyncCursor,
  type MonthFile,
  type StoredMessage,
} from "./slackMirror";

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

describe("path + period helpers", () => {
  it("monthFilePath / syncFilePath honor baseDir and channel name", () => {
    const base = "/tmp/mirror";
    expect(monthFilePath("field-qa", "2026-06", { baseDir: base })).toBe(
      "/tmp/mirror/field-qa/2026-06.json",
    );
    expect(syncFilePath("field-qa", { baseDir: base })).toBe(
      "/tmp/mirror/field-qa/_sync.json",
    );
  });

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
});

describe("month-file + cursor I/O", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "slack-mirror-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writeMonthFile then readMonthFile round-trips (creating dirs)", () => {
    const file: MonthFile = {
      version: 1,
      channel: "field-qa",
      month: "2026-06",
      messages: { "1.1": stored({ ts: "1.1" }) },
    };
    writeMonthFile("field-qa", "2026-06", file, { baseDir });
    expect(readMonthFile("field-qa", "2026-06", { baseDir })).toEqual(file);
  });

  it("readMonthFile returns null for an absent file", () => {
    expect(readMonthFile("field-qa", "1999-01", { baseDir })).toBeNull();
  });

  it("sync cursor round-trips; missing cursor → null", () => {
    expect(readSyncCursor("field-qa", { baseDir })).toBeNull();
    writeSyncCursor("field-qa", "2026-06-12T00:00:00.000Z", { baseDir });
    expect(readSyncCursor("field-qa", { baseDir })).toEqual({
      version: 1,
      lastSync: "2026-06-12T00:00:00.000Z",
    });
  });
});
