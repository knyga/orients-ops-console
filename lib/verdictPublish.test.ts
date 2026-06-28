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
    expect(msg).toMatch(/^✅ 2026-06-18 \(четвер\) — прийнято/);
    expect(msg).toContain("датасет ✓");
    expect(msg).toMatch(/1144%|114[0-9]%/); // 206/18 ≈ 1144%
  });

  it("formats a NEEDS_REVIEW day, rebuilding the gap wording in Ukrainian from fields", () => {
    const msg = formatDayMessage(
      // English reasons in the verdict must NOT leak — the message is rebuilt
      // from the structured fields (airborne 18m, video 2m, 11%).
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", videoMinutes: 2, ratio: 0.1, datasetPosted: false, reasons: ["video 2m is 10% of airborne 20m (< 50%)", "no #datasets notice for the day"] }),
    );
    expect(msg).toMatch(/^⚠️ 2026-06-13 \(субота\) — потрібна перевірка:/);
    expect(msg).toContain("< 50%");
    expect(msg).toContain("немає повідомлення про датасет");
    expect(msg).toContain("18 хв");
    expect(msg).not.toContain("airborne");
  });

  it("rebuilds the no-airborne gap in Ukrainian when ratio is null", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 5, ratio: null, datasetPosted: true, reasons: ["no airborne time recorded for the day"] }),
    );
    expect(msg).toContain("немає записаного часу в повітрі за день");
  });

  it("formats an ACCEPTED_EXCEPTION day, passing the human reason through verbatim", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "ACCEPTED_EXCEPTION", reasons: ["форс-мажор: гроза"] }),
    );
    expect(msg).toMatch(/^🟡 2026-06-13 \(субота\) — прийнято \(виняток\): форс-мажор: гроза/);
  });
});

describe("formatOverride", () => {
  it("strikes the original and amends for an approve", () => {
    const o = formatOverride("⚠️ 2026-06-04 — потрібна перевірка: …", "accepted_exception", "Oleksandr K", "ми тестували");
    expect(o.updatedText).toBe("~⚠️ 2026-06-04 — потрібна перевірка: …~\n🟡 Оновлено → прийнято (виняток), Oleksandr K: ми тестували");
    expect(o.replyText).toMatch(/^🟡 Зафіксовано: прийнято \(виняток\), Oleksandr K\. Причина: ми тестували/);
  });

  it("uses the rejected icon/label for a disapprove", () => {
    const o = formatOverride("✅ 2026-06-05 — прийнято …", "rejected", "Bohdan Forostianyi", "не приймається");
    expect(o.updatedText).toContain("~✅ 2026-06-05 — прийнято …~");
    expect(o.updatedText).toContain("⛔ Оновлено → відхилено, Bohdan Forostianyi: не приймається");
    expect(o.replyText).toMatch(/^⛔ Зафіксовано: відхилено/);
  });
});
