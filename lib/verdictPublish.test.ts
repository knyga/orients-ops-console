import { describe, expect, it } from "vitest";
import { formatDayMessage, formatOverride, publishableDays, ROSTER_MARKER, splitRosterSuffix, withRosterSuffix } from "./verdictPublish";
import type { DayVerdict } from "./fieldDayVerdict";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-18",
  status: "ACCEPTED",
  airborneMinutes: 18,
  videoMinutes: 206,
  ratio: 206 / 18,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: [],
  unknownInitials: [],
  airborneReported: true,
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
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", videoMinutes: 2, ratio: 0.1, datasetStatus: "MISSING", reasons: ["video 2m is 10% of airborne 20m (< 50%)", "no #datasets notice for the day"] }),
    );
    expect(msg).toMatch(/^⚠️ 2026-06-13 \(субота\) — потрібна перевірка:/);
    expect(msg).toContain("< 50%");
    expect(msg).toContain("немає повідомлення про датасет");
    expect(msg).toContain("18 хв");
    expect(msg).not.toContain("airborne");
  });

  it("rebuilds the no-airborne gap in Ukrainian when ratio is null", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 5, ratio: null, datasetStatus: "POSTED", reasons: ["no airborne time recorded for the day"] }),
    );
    expect(msg).toContain("немає записаного часу в повітрі за день");
  });

  it("NEEDS_REVIEW airborne-unknown day: honest wording + deploy window, no '0 хв у повітрі'", () => {
    const msg = formatDayMessage(day({
      status: "NEEDS_REVIEW",
      airborneMinutes: 0,
      videoMinutes: 0,
      ratio: null,
      datasetStatus: "MISSING",
      airborneReported: false,
      deployWindow: { start: "17:00", end: "20:00" },
      roster: ["Андріан", "Сергій"],
    }));
    expect(msg).toContain("політ відбувся (17:00–20:00), але час у повітрі не вказано");
    expect(msg).not.toContain("хв у повітрі,"); // trailing parenthetical dropped the airborne clause
    expect(msg).not.toContain("0 хв у повітрі");
    expect(msg).toContain("👥 У полі: Андріан, Сергій.");
  });

  it("NEEDS_REVIEW with a real airborne figure still shows the airborne clause", () => {
    const msg = formatDayMessage(day({
      status: "NEEDS_REVIEW",
      airborneMinutes: 85,
      videoMinutes: 0,
      ratio: 0,
      datasetStatus: "MISSING",
      airborneReported: true,
    }));
    expect(msg).toContain("85 хв у повітрі");
  });

  it("formats an ACCEPTED_EXCEPTION day, passing a bare human reason through verbatim", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "ACCEPTED_EXCEPTION", reasons: ["форс-мажор: гроза"] }),
    );
    expect(msg).toMatch(/^🟡 2026-06-13 \(субота\) — прийнято \(виняток\): форс-мажор: гроза/);
  });

  it("renders the waived dataset marker (Ukrainian)", () => {
    const msg = formatDayMessage({ date: "2026-06-10", status: "ACCEPTED", airborneMinutes: 100, videoMinutes: 60, ratio: 0.6, datasetStatus: "WAIVED", withinGrace: false, reasons: [], roster: [], unknownInitials: [], airborneReported: true });
    expect(msg).toContain("датасет 📝 виняток");
  });

  it("rebuilds machine gaps in Ukrainian for ACCEPTED_EXCEPTION, keeping the human note verbatim", () => {
    // Real applyResolution shape: machine gaps (English) + a trailing
    // `exception (by): note`. Gaps must be rebuilt in Ukrainian from fields; the
    // `exception` label becomes `виняток`; the human note text stays verbatim.
    const msg = formatDayMessage(
      day({
        date: "2026-06-04",
        status: "ACCEPTED_EXCEPTION",
        airborneMinutes: 32,
        videoMinutes: 0,
        ratio: 0,
        datasetStatus: "MISSING",
        reasons: [
          "video 0m is 0% of airborne 32m (< 50%)",
          "no #datasets notice for the day",
          'exception (Oleksandr K): approver replied "approve"',
        ],
      }),
    );
    expect(msg).toMatch(/^🟡 2026-06-04 \(четвер\) — прийнято \(виняток\):/);
    expect(msg).toContain("відео 0 хв — лише 0% від 32 хв у повітрі (< 50%)");
    expect(msg).toContain("немає повідомлення про датасет за цей день");
    expect(msg).toContain('виняток (Oleksandr K): approver replied "approve"');
    expect(msg).not.toContain("airborne");
    expect(msg).not.toContain("exception (");
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

describe("crew suffix", () => {
  it("round-trips body + roster", () => {
    const body = "✅ 2026-06-13 — прийнято.";
    const text = withRosterSuffix(body, ["Андріан", "Любомир"]);
    expect(text).toBe(`${body}\n${ROSTER_MARKER}Андріан, Любомир.`);
    const split = splitRosterSuffix(text);
    expect(split.body).toBe(body);
    expect(split.rosterLine).toBe(`${ROSTER_MARKER}Андріан, Любомир.`);
  });

  it("omits the suffix for an empty roster and splits cleanly when absent", () => {
    expect(withRosterSuffix("body", [])).toBe("body");
    expect(splitRosterSuffix("body")).toEqual({ body: "body", rosterLine: null });
  });

  it("formatDayMessage appends the crew line for an ACCEPTED day", () => {
    const msg = formatDayMessage(day({ roster: ["Андріан", "Любомир"] }));
    expect(msg).toContain(`\n${ROSTER_MARKER}Андріан, Любомир.`);
  });

  it("formatDayMessage omits the crew line when roster is empty", () => {
    expect(formatDayMessage(day({ roster: [] }))).not.toContain(ROSTER_MARKER);
  });

  it("an override strike leaves the crew line intact (disjoint regions)", () => {
    const published = withRosterSuffix("⚠️ 2026-06-04 — потрібна перевірка: …", ["Тарас"]);
    const { body, rosterLine } = splitRosterSuffix(published);
    const o = formatOverride(body, "accepted_exception", "Oleksandr K", "ми тестували");
    const result = rosterLine ? `${o.updatedText}\n${rosterLine}` : o.updatedText;
    expect(result).toContain("~⚠️ 2026-06-04 — потрібна перевірка: …~");
    expect(result).toContain(`${ROSTER_MARKER}Тарас.`);
    expect(result).not.toContain("~👥");
  });
});
