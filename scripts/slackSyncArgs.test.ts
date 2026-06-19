import { describe, expect, it } from "vitest";
import { firstOfMonth, parseArgs, subtractDaysIso } from "./slackSyncArgs";

describe("parseArgs", () => {
  it("defaults to incremental mode with a 7-day window", () => {
    expect(parseArgs([])).toEqual({ mode: "incremental", window: 7 });
  });

  it("reads the init positional", () => {
    expect(parseArgs(["init"]).mode).toBe("init");
  });

  it("reads --backfill, --since, --window, --channel", () => {
    expect(parseArgs(["--backfill", "--since", "2026-02-01", "--channel", "field-qa"])).toEqual({
      mode: "backfill",
      since: "2026-02-01",
      window: 7,
      channel: "field-qa",
    });
    expect(parseArgs(["--window", "14"]).window).toBe(14);
  });

  it("throws on a malformed --since", () => {
    expect(() => parseArgs(["--since", "2026/02/01"])).toThrow(/--since/);
  });

  it("throws on a negative or non-numeric --window", () => {
    expect(() => parseArgs(["--window", "-1"])).toThrow(/--window/);
    expect(() => parseArgs(["--window", "abc"])).toThrow(/--window/);
  });
});

describe("firstOfMonth", () => {
  it("returns the first day of today's calendar month", () => {
    expect(firstOfMonth("2026-06-19")).toBe("2026-06-01");
  });
});

describe("subtractDaysIso", () => {
  it("subtracts whole days, crossing a month boundary", () => {
    expect(subtractDaysIso("2026-06-03T00:00:00.000Z", 7)).toBe("2026-05-27T00:00:00.000Z");
  });
});
