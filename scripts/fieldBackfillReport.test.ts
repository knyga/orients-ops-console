import { describe, expect, it } from "vitest";
import { formatDryRun } from "./fieldBackfillReport";
import type { BackfillItem } from "../lib/backfillPublished";

const item = (over: Partial<BackfillItem>): BackfillItem => ({
  date: "2026-06-08",
  channel: "field-qa",
  ts: "1.1",
  oldText: "⚠️ 2026-06-08 — needs review: …",
  newText: "⚠️ 2026-06-08 (понеділок) — потрібна перевірка: …",
  action: "update",
  reason: "needs-update",
  overridden: false,
  ...over,
});

describe("formatDryRun", () => {
  it("shows the update count, target channel, each old→new, and sends nothing", () => {
    const plan = [item({}), item({ date: "2026-06-09", action: "skip", reason: "already-current" })];
    const out = formatDryRun(plan, "field-qa", { start: "2026-06-01", end: "2026-06-30" });
    expect(out).toMatch(/DRY RUN — would update 1 message\(s\) in #field-qa/);
    expect(out).toContain("1 already current");
    expect(out).toContain("⚠️ 2026-06-08 — needs review: …");
    expect(out).toContain("⚠️ 2026-06-08 (понеділок) — потрібна перевірка: …");
    expect(out).toContain("No messages were sent");
  });

  it("flags overridden and no-verdict skips so they are visible, not silent", () => {
    const plan = [
      item({ date: "2026-06-04", action: "skip", reason: "overridden", overridden: true }),
      item({ date: "2026-06-30", action: "skip", reason: "no-verdict" }),
    ];
    const out = formatDryRun(plan, "field-qa", { start: "2026-06-01", end: "2026-06-30" });
    expect(out).toMatch(/would update 0 message/);
    expect(out).toContain("overridden");
    expect(out).toContain("2026-06-04");
    expect(out).toContain("no verdict");
    expect(out).toContain("2026-06-30");
  });

  it("notes when no channel is set", () => {
    const out = formatDryRun([item({})], undefined, { start: "2026-06-01", end: "2026-06-30" });
    expect(out).toContain("no channel");
  });
});
