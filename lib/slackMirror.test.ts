import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  monthFilePath,
  monthsInPeriod,
  syncFilePath,
} from "./slackMirror";

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
