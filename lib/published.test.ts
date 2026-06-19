import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPublished,
  readPublished,
  recordPublished,
  writePublished,
  type PublishedEntry,
  type PublishedLog,
} from "./published";

const period = { start: "2026-06-01", end: "2026-06-30" };
const entry = (over: Partial<PublishedEntry>): PublishedEntry => ({
  date: "2026-06-18",
  channel: "field-qa",
  text: "✅ 2026-06-18 — accepted",
  postedAt: "2026-06-20T00:00:00.000Z",
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

describe("store I/O", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "published-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("round-trips; missing log → {}", () => {
    expect(readPublished(period, { baseDir })).toEqual({});
    const log = recordPublished({}, entry({}));
    writePublished(period, log, { baseDir });
    expect(readPublished(period, { baseDir })).toEqual(log);
  });

  it("keys by period, so different months are separate logs", () => {
    writePublished(period, recordPublished({}, entry({})), { baseDir });
    const may = { start: "2026-05-01", end: "2026-05-31" };
    expect(readPublished(may, { baseDir })).toEqual({});
  });
});
