import { describe, expect, it } from "vitest";
import { formatDayMessage, formatOverride, publishableDays } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-18",
  status: "ACCEPTED",
  airborneMinutes: 18,
  videoMinutes: 206,
  ratio: 206 / 18,
  datasetPosted: true,
  withinGrace: false,
  reasons: [],
  ...over,
});

describe("publishableDays", () => {
  it("includes settled statuses and excludes PENDING", () => {
    const days = [
      day({ date: "2026-06-18", status: "ACCEPTED" }),
      day({ date: "2026-06-17", status: "PENDING" }),
      day({ date: "2026-06-13", status: "NEEDS_REVIEW" }),
      day({ date: "2026-06-12", status: "ACCEPTED_EXCEPTION" }),
    ];
    expect(publishableDays(days).map((d) => d.date)).toEqual([
      "2026-06-18",
      "2026-06-13",
      "2026-06-12",
    ]);
  });
});

describe("formatDayMessage", () => {
  it("formats an ACCEPTED day with ratio and dataset", () => {
    const msg = formatDayMessage(day({}));
    expect(msg).toMatch(/^✅ 2026-06-18 — accepted/);
    expect(msg).toContain("dataset ✓");
    expect(msg).toMatch(/1144%|114[0-9]%/); // 206/18 ≈ 1144%
  });

  it("formats a NEEDS_REVIEW day with its reasons and no-dataset note", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", videoMinutes: 2, ratio: 0.1, datasetPosted: false, reasons: ["video 2m is 10% of airborne 20m (< 50%)", "no #datasets notice for the day"] }),
    );
    expect(msg).toMatch(/^⚠️ 2026-06-13 — needs review:/);
    expect(msg).toContain("< 50%");
    expect(msg).toContain("no dataset");
  });

  it("formats an ACCEPTED_EXCEPTION day with the exception note", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "ACCEPTED_EXCEPTION", reasons: ["exception: force majeure"] }),
    );
    expect(msg).toMatch(/^🟡 2026-06-13 — accepted \(exception\): exception: force majeure/);
  });
});

describe("formatOverride", () => {
  it("strikes the original and amends for an approve", () => {
    const o = formatOverride("⚠️ 2026-06-04 — needs review: …", "accepted_exception", "Oleksandr K", "we were testing");
    expect(o.updatedText).toBe("~⚠️ 2026-06-04 — needs review: …~\n🟡 Updated → accepted (exception) by Oleksandr K: we were testing");
    expect(o.replyText).toMatch(/^🟡 Recorded: accepted \(exception\) by Oleksandr K\. Reason: we were testing/);
  });

  it("uses the rejected icon/label for a disapprove", () => {
    const o = formatOverride("✅ 2026-06-05 — accepted …", "rejected", "Bohdan Forostianyi", "not acceptable");
    expect(o.updatedText).toContain("~✅ 2026-06-05 — accepted …~");
    expect(o.updatedText).toContain("⛔ Updated → rejected by Bohdan Forostianyi: not acceptable");
    expect(o.replyText).toMatch(/^⛔ Recorded: rejected/);
  });
});
