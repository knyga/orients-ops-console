import { describe, expect, it } from "vitest";
import { formatDayMessage, formatOverride, formatTimeTail, formatDuration, publishableDays, ROSTER_MARKER, splitRosterSuffix, splitDroneLine, withRosterSuffix, parseRosterSuffix, withDroneLine, withLossLine } from "./verdictPublish";
import { mentionize, dementionText } from "./mention";
import { LINKS_MARKER } from "./linksRegion";
import type { DayVerdict } from "./fieldDayVerdict";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-18",
  reportTs: null,
  reportSeq: 1,
  reportCount: 1,
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

  it("rebuilds a telemetry no-fly gap in Ukrainian when airborne is a reported 0", () => {
    const msg = formatDayMessage(
      day({ date: "2026-06-13", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 5, ratio: null, datasetStatus: "POSTED", reasons: ["drones did not fly (0 flights, 0 min airborne)"] }),
    );
    expect(msg).toContain("за телеметрією польотів не було (0 хв у повітрі)");
    expect(msg).not.toContain("немає записаного часу");
  });

  it("adds the Звіт-conflict clause + short tail when a no-fly day has a deploy window", () => {
    const msg = formatDayMessage(day({
      date: "2026-06-21", status: "NEEDS_REVIEW", airborneMinutes: 0, videoMinutes: 0, ratio: null,
      datasetStatus: "MISSING", airborneReported: true, deployWindow: { start: "17:00", end: "20:00" },
      roster: ["Андріан", "Сергій"],
    }));
    expect(msg).toContain("за телеметрією польотів не було (0 хв у повітрі), хоча у звіті — виїзд 17:00–20:00");
    expect(msg).toContain("немає повідомлення про датасет");
    expect(msg).toContain("(виїзд 17:00–20:00; у повітрі 0 хв;"); // uniform tail
    expect(msg).toContain(`👥 У полі: ${mentionize("Андріан")}, ${mentionize("Сергій")}.`);
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
    expect(msg).toContain("у повітрі — не вказано"); // uniform tail, honest about the unknown
    expect(msg).not.toContain("у повітрі 0 хв");
    expect(msg).toContain(`👥 У полі: ${mentionize("Андріан")}, ${mentionize("Сергій")}.`);
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
    expect(msg).toMatch(/^✅ 2026-06-13 \(субота\) — прийнято \(виняток\): форс-мажор: гроза/);
  });

  it("renders the waived dataset marker (Ukrainian)", () => {
    const msg = formatDayMessage({ date: "2026-06-10", reportTs: null, reportSeq: 1, reportCount: 1, status: "ACCEPTED", airborneMinutes: 100, videoMinutes: 60, ratio: 0.6, datasetStatus: "WAIVED", withinGrace: false, reasons: [], roster: [], unknownInitials: [], airborneReported: true });
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
    expect(msg).toMatch(/^✅ 2026-06-04 \(четвер\) — прийнято \(виняток\):/);
    expect(msg).toContain("відео 0 хв — лише 0% від 32 хв у повітрі (< 50%)");
    expect(msg).toContain("немає повідомлення про датасет за цей день");
    expect(msg).toContain('виняток (Oleksandr K): approver replied "approve"');
    expect(msg).not.toContain("airborne");
    expect(msg).not.toContain("exception (");
  });

  it("labels multi-report days «виїзд N/M (window)» and keeps single-report days byte-identical", () => {
    const base: DayVerdict = {
      date: "2026-07-01", reportTs: "2.0", reportSeq: 2, reportCount: 2,
      status: "REJECTED", airborneMinutes: 18.1, videoMinutes: 29, ratio: 29 / 18.1,
      datasetStatus: "POSTED", withinGrace: false,
      reasons: ["deployment 110m is under 3h"], roster: ["Влад", "Любомир"],
      unknownInitials: [], airborneReported: true,
      deployWindow: { start: "18:20", end: "20:10" }, deployMin: 110,
      droneReportPresent: true, hasZvit: true,
    };
    expect(formatDayMessage(base)).toContain("2026-07-01 (середа), виїзд 2/2 (18:20–20:10) — відхилено");
    const single: DayVerdict = { ...base, reportTs: "1.0", reportSeq: 1, reportCount: 1 };
    expect(formatDayMessage(single)).not.toContain("виїзд 1/1");
  });
});

describe("formatOverride", () => {
  it("strikes the original and amends for an approve", () => {
    const o = formatOverride("⚠️ 2026-06-04 — потрібна перевірка: …", "accepted_exception", "Oleksandr K", "ми тестували");
    expect(o.updatedText).toBe(`~⚠️ 2026-06-04 — потрібна перевірка: …~\n✅ Оновлено → прийнято (виняток), ${mentionize("Oleksandr K")}: ми тестували`);
    expect(o.replyText).toMatch(new RegExp(`^✅ Зафіксовано: прийнято \\(виняток\\), ${mentionize("Oleksandr K")}\\. Причина: ми тестували`));
  });

  it("uses the rejected icon/label for a disapprove", () => {
    const o = formatOverride("✅ 2026-06-05 — прийнято …", "rejected", "Bohdan Forostianyi", "не приймається");
    expect(o.updatedText).toContain("~✅ 2026-06-05 — прийнято …~");
    expect(o.updatedText).toContain(`⛔ Оновлено → відхилено, ${mentionize("Bohdan Forostianyi")}: не приймається`);
    expect(o.replyText).toMatch(/^⛔ Зафіксовано: відхилено/);
  });

  it("mentions the approver in an override", () => {
    const { replyText } = formatOverride("✅ 2026-06-13 — прийнято (…).", "rejected", "Oleksandr K", "no dataset");
    expect(replyText).toContain(mentionize("Oleksandr K"));
  });
});

describe("crew suffix", () => {
  it("round-trips body + roster", () => {
    const body = "✅ 2026-06-13 — прийнято.";
    const text = withRosterSuffix(body, ["Андріан", "Любомир"]);
    expect(text).toBe(`${body}\n${ROSTER_MARKER}${mentionize("Андріан")}, ${mentionize("Любомир")}.`);
    const split = splitRosterSuffix(text);
    expect(split.body).toBe(body);
    expect(split.rosterLine).toBe(`${ROSTER_MARKER}${mentionize("Андріан")}, ${mentionize("Любомир")}.`);
  });

  it("omits the suffix for an empty roster and splits cleanly when absent", () => {
    expect(withRosterSuffix("body", [])).toBe("body");
    expect(splitRosterSuffix("body")).toEqual({ body: "body", rosterLine: null, droneLine: null, linksLine: null });
  });

  it("round-trips the roster namespace: first-names out as mentions, back as first-names", () => {
    expect(parseRosterSuffix(withRosterSuffix("body", ["Влад", "Тарас"]))).toEqual(["Влад", "Тарас"]);
  });

  it("formatDayMessage appends the crew line for an ACCEPTED day", () => {
    const msg = formatDayMessage(day({ roster: ["Андріан", "Любомир"] }));
    expect(msg).toContain(`\n${ROSTER_MARKER}${mentionize("Андріан")}, ${mentionize("Любомир")}.`);
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
    expect(result).toContain(`${ROSTER_MARKER}${mentionize("Тарас")}.`);
    expect(result).not.toContain("~👥");
  });
});

const droneBase: DayVerdict = {
  date: "2026-06-25",
  reportTs: null,
  reportSeq: 1,
  reportCount: 1,
  status: "NEEDS_REVIEW",
  airborneMinutes: 0,
  videoMinutes: 0,
  ratio: null,
  datasetStatus: "MISSING",
  withinGrace: false,
  reasons: [],
  roster: ["Влад", "Тарас"],
  unknownInitials: [],
  airborneReported: false,
  deployWindow: { start: "16:30", end: "19:00" },
  droneReport: [
    { name: "Андріан", isPerson: true, count: 2 },
    { name: "Демонстраційні", isPerson: false, count: 8 },
  ],
};

describe("formatDayMessage drone line", () => {
  it("appends the drone line after the crew suffix", () => {
    const msg = formatDayMessage(droneBase);
    expect(msg).toContain(`\n👥 У полі: ${mentionize("Влад")}, ${mentionize("Тарас")}.`);
    expect(msg).toContain(`\n🛸 Дрони: ${mentionize("Андріан")} 2, інші 8 (усього 10)`);
    expect(msg.indexOf("👥")).toBeLessThan(msg.indexOf("🛸")); // crew before drones
  });
  it("omits the drone line when drone presence is unknown (legacy verdict)", () => {
    expect(formatDayMessage({ ...droneBase, droneReport: undefined, droneReportPresent: undefined })).not.toContain("🛸");
  });
  it("states the absence explicitly when the extraction says the day had no report", () => {
    const msg = formatDayMessage({ ...droneBase, droneReport: undefined, droneReportPresent: false });
    expect(msg).toContain("\n🛸 Дрони: звіт не подано.");
  });
  it("states the absence on a no-fly day too", () => {
    const msg = formatDayMessage({
      ...droneBase, droneReport: undefined, droneReportPresent: false,
      airborneReported: true, airborneMinutes: 0, videoMinutes: 0, ratio: null, deployWindow: undefined,
    });
    expect(msg).toContain("\n🛸 Дрони: звіт не подано.");
    expect(msg.indexOf("👥")).toBeLessThan(msg.indexOf("🛸"));
  });
  it("counts win over the absence marker when both could apply", () => {
    const msg = formatDayMessage({ ...droneBase, droneReportPresent: true });
    expect(msg).toContain(`🛸 Дрони: ${mentionize("Андріан")} 2, інші 8 (усього 10)`);
    expect(msg).not.toContain("звіт не подано");
  });
  // Per-person axis (2026-07-28): owners on the crew who still owe their OWN
  // submission render inside the single 🛸 line, so region splitters hold.
  it("appends «без звіту: …» to the counts line for owners who did not submit", () => {
    const msg = formatDayMessage({ ...droneBase, droneMissingSubmitters: ["Влад"] });
    expect(msg).toContain(
      `\n🛸 Дрони: ${mentionize("Андріан")} 2, інші 8 (усього 10); без звіту: ${mentionize("Влад")}`,
    );
  });
  it("renders «звіт не подано — очікуємо: …» when nobody reported at all", () => {
    const msg = formatDayMessage({
      ...droneBase, droneReport: undefined, droneMissingSubmitters: ["Влад", "Любомир"],
    });
    expect(msg).toContain(
      `\n🛸 Дрони: звіт не подано — очікуємо: ${mentionize("Влад")}, ${mentionize("Любомир")}.`,
    );
  });
  it("the missing-submitters render stays a single trailing 🛸 line (splitters hold)", () => {
    const msg = formatDayMessage({ ...droneBase, droneMissingSubmitters: ["Влад"] });
    const { droneLine, rosterLine } = splitRosterSuffix(msg);
    expect(droneLine).toContain("без звіту:");
    expect(rosterLine).toBe(`👥 У полі: ${mentionize("Влад")}, ${mentionize("Тарас")}.`);
  });
});

describe("region discipline", () => {
  const withDrones = formatDayMessage(droneBase);
  it("splitRosterSuffix peels the crew line drone-free and returns the drone line", () => {
    const { body, rosterLine, droneLine } = splitRosterSuffix(withDrones);
    expect(rosterLine).toBe(`👥 У полі: ${mentionize("Влад")}, ${mentionize("Тарас")}.`);
    expect(droneLine).toBe(`🛸 Дрони: ${mentionize("Андріан")} 2, інші 8 (усього 10)`);
    expect(body).not.toContain("👥");
    expect(body).not.toContain("🛸");
  });
  it("parseRosterSuffix ignores the drone line", () => {
    // Roundtrips through mentionize/dementionText, so it comes back as the
    // registry's canonical name (not necessarily the alias that was stored).
    expect(parseRosterSuffix(withDrones)).toEqual([dementionText(mentionize("Влад")), dementionText(mentionize("Тарас"))]);
  });
  it("withDroneLine round-trips a re-composed message", () => {
    const { body, rosterLine, droneLine } = splitRosterSuffix(withDrones);
    const recomposed = withDroneLine(`${body}\n${rosterLine}`, droneBase.droneReport);
    expect(recomposed).toBe(withDrones);
    expect(droneLine).not.toBeNull();
  });
  it("no drone line → droneLine null, crew still parses", () => {
    const plain = formatDayMessage({ ...droneBase, droneReport: undefined });
    const { rosterLine, droneLine } = splitRosterSuffix(plain);
    expect(droneLine).toBeNull();
    expect(rosterLine).toBe(`👥 У полі: ${mentionize("Влад")}, ${mentionize("Тарас")}.`);
  });
});

describe("REJECTED rendering", () => {
  const rejected: DayVerdict = {
    date: "2026-06-30", reportTs: null, reportSeq: 1, reportCount: 1, status: "REJECTED", airborneMinutes: 18.1, videoMinutes: 29,
    ratio: 29 / 18.1, datasetStatus: "POSTED", withinGrace: false,
    reasons: ["deployment 120m is under 3h"], roster: ["Влад", "Любомир"],
    unknownInitials: [], airborneReported: true, deployMin: 120, droneReportPresent: true, hasZvit: true,
  };

  it("renders відхилено with the short-deploy gap in Ukrainian", () => {
    const msg = formatDayMessage(rejected);
    expect(msg).toContain("⛔ 2026-06-30");
    expect(msg).toContain("відхилено: виїзд 120 хв — менше 3 год");
    expect(msg).toContain(`👥 У полі: ${mentionize("Влад")}, ${mentionize("Любомир")}.`);
    expect(msg).not.toMatch(/прийнято/);
  });

  // The drone axis is per-person since 2026-07-28: a missing report renders in
  // the 🛸 region («звіт не подано» / «без звіту: …»), never as a day gap.
  it("does not render a missing drone report as a day gap", () => {
    const msg = formatDayMessage({ ...rejected, droneReportPresent: false });
    expect(msg).not.toContain("немає звіту про кількість дронів");
    expect(msg).toContain("🛸 Дрони: звіт не подано.");
  });

  it("REJECTED days are publishable", () => {
    expect(publishableDays([rejected])).toHaveLength(1);
  });

  it("surfaces the human rejection note when no machine gap fails", () => {
    // applyResolution can flip a gate-passing day to REJECTED, appending
    // `rejected (<by>): <note>` last — the note must reach the channel.
    const msg = formatDayMessage({
      ...rejected,
      airborneMinutes: 60, videoMinutes: 40, ratio: 40 / 60,
      deployMin: 240, droneReportPresent: true, hasZvit: true, datasetStatus: "POSTED",
      reasons: ["rejected (Oleksandr K): день не зараховано"],
    });
    expect(msg).toContain("відхилено (Oleksandr K): день не зараховано");
    expect(msg).not.toMatch(/відхилено:\s{2}/);
  });
});

describe("formatDuration", () => {
  it("renders minutes-only under an hour", () => expect(formatDuration(45)).toBe("45 хв"));
  it("renders whole hours without minutes", () => expect(formatDuration(240)).toBe("4 год"));
  it("renders mixed hours and minutes", () => expect(formatDuration(510)).toBe("8 год 30 хв"));
  it("rounds fractional minutes without producing 60 хв", () => expect(formatDuration(119.7)).toBe("2 год"));
});

describe("formatTimeTail", () => {
  const base = day({
    deployWindow: { start: "08:00", end: "16:30" }, deployMin: 510,
    airborneMinutes: 45, videoMinutes: 30, ratio: 30 / 45, datasetStatus: "POSTED",
  });

  it("renders all four segments in order", () => {
    expect(formatTimeTail(base)).toBe("(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓)");
  });
  it("window-only when duration is unknown", () => {
    expect(formatTimeTail({ ...base, deployMin: null })).toContain("виїзд 08:00–16:30;");
  });
  it("duration-only when the window is unknown", () => {
    expect(formatTimeTail({ ...base, deployWindow: undefined, deployMin: 240 })).toContain("(виїзд 4 год;");
  });
  it("flew but no deploy info → виїзд — не вказано", () => {
    expect(formatTimeTail({ ...base, deployWindow: undefined, deployMin: undefined })).toContain("(виїзд — не вказано;");
  });
  it("reported no-fly day with no deploy info omits the виїзд segment", () => {
    const t = formatTimeTail({ ...base, deployWindow: undefined, deployMin: undefined, airborneMinutes: 0, ratio: null, airborneReported: true });
    expect(t).not.toContain("виїзд");
    expect(t).toContain("(у повітрі 0 хв;");
  });
  it("airborne unreported → у повітрі — не вказано", () => {
    const t = formatTimeTail({ ...base, airborneMinutes: 0, ratio: null, airborneReported: false });
    expect(t).toContain("у повітрі — не вказано");
    expect(t).not.toContain("у повітрі 0 хв");
  });
  it("null ratio drops the percent", () => {
    expect(formatTimeTail({ ...base, ratio: null })).toContain("відео 30 хв;");
  });
});

describe("uniform tail on every status", () => {
  const timed = (over: Partial<DayVerdict>) => day({
    deployWindow: { start: "08:00", end: "16:30" }, deployMin: 510,
    airborneMinutes: 45, videoMinutes: 30, ratio: 30 / 45, datasetStatus: "POSTED", ...over,
  });
  const TAIL = "(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓)";

  it("ACCEPTED", () => {
    expect(formatDayMessage(timed({}))).toContain(`— прийнято ${TAIL}.`);
  });
  it("NEEDS_REVIEW", () => {
    expect(formatDayMessage(timed({ status: "NEEDS_REVIEW", datasetStatus: "MISSING" })))
      .toContain("(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; без датасету).");
  });
  it("ACCEPTED_EXCEPTION", () => {
    expect(formatDayMessage(timed({ status: "ACCEPTED_EXCEPTION", reasons: ["exception (Oleksandr K): форс-мажор"] })))
      .toContain(`виняток (Oleksandr K): форс-мажор ${TAIL}.`);
  });
  it("REJECTED", () => {
    expect(formatDayMessage(timed({ status: "REJECTED", deployMin: 120, reasons: ["deployment 120m is under 3h"] })))
      .toContain("(виїзд 08:00–16:30 — 2 год; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓).");
  });
});

describe("new curable-gap phrases", () => {
  it("no-Звіт day", () => {
    const day: DayVerdict = {
      date: "2026-06-03", reportTs: null, reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW", airborneMinutes: 42.75, videoMinutes: 36,
      ratio: 36 / 42.75, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: [],
      unknownInitials: [], airborneReported: true, hasZvit: false,
    };
    expect(formatDayMessage(day)).toContain("політ зафіксовано, але немає Звіту (екіпаж невідомий)");
  });

  it("deploy window not recorded", () => {
    const day: DayVerdict = {
      date: "2026-06-16", reportTs: null, reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW", airborneMinutes: 36.48, videoMinutes: 93,
      ratio: 93 / 36.48, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: ["Андріан", "Надія"],
      unknownInitials: [], airborneReported: true, deployMin: null, hasZvit: true,
    };
    expect(formatDayMessage(day)).toContain("у Звіті не вказано час виїзду");
  });

  it("video under the 2-minute floor", () => {
    const day: DayVerdict = {
      date: "2026-06-05", reportTs: null, reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW", airborneMinutes: 2, videoMinutes: 1.5,
      ratio: 0.75, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: [],
      unknownInitials: [], airborneReported: true,
    };
    expect(formatDayMessage(day)).toContain("відео 1.5 хв — менше 2 хв");
  });
});

const lossDay = (loss?: { lost: boolean; found: boolean }): DayVerdict => ({
  date: "2026-07-04",
  reportTs: "111.222",
  reportSeq: 1,
  reportCount: 1,
  status: "ACCEPTED",
  airborneMinutes: 120,
  videoMinutes: 90,
  ratio: 0.75,
  datasetStatus: "POSTED",
  withinGrace: false,
  reasons: [],
  roster: ["Андріан", "Данило"],
  unknownInitials: [],
  airborneReported: true,
  ...(loss ? { loss } : {}),
});

describe("loss line", () => {
  it("renders the unrecovered-loss line inside the body (above the crew line)", () => {
    const text = formatDayMessage(lossDay({ lost: true, found: false }));
    expect(text).toContain("⚠️ Втрата борта (не знайдено).");
    expect(text.indexOf("Втрата борта")).toBeLessThan(text.indexOf("👥 У полі:"));
  });
  it("renders the recovered line", () => {
    expect(formatDayMessage(lossDay({ lost: true, found: true }))).toContain("✅ Борт втрачено і знайдено.");
  });
  it("is byte-identical to the old render when there is no loss", () => {
    expect(formatDayMessage(lossDay())).toBe(formatDayMessage(lossDay(undefined)));
    expect(formatDayMessage(lossDay())).not.toContain("борт");
  });
  it("withLossLine is a no-op without a loss", () => {
    expect(withLossLine("body", lossDay())).toBe("body");
  });
});

describe("region splitters with a trailing 🔗 line", () => {
  const body = "✅ 18.06 — прийнято (у повітрі 18 хв; відео 206 хв — 1144%; датасет ✓).";
  const roster = `${ROSTER_MARKER}<@U1>, <@U2>.`;
  const drone = "🛸 Дрони: Влад 3; разом 3";
  const links = `${LINKS_MARKER}<https://x/p1|Звіт> · <https://x/p2|Дрони>`;
  const full = [body, roster, drone, links].join("\n");

  it("splitDroneLine peels 🔗 first, then the 🛸 line", () => {
    expect(splitDroneLine(full)).toEqual({ rest: `${body}\n${roster}`, droneLine: drone, linksLine: links });
  });
  it("splitDroneLine without 🔗 is unchanged in shape", () => {
    expect(splitDroneLine(`${body}\n${drone}`)).toEqual({ rest: body, droneLine: drone, linksLine: null });
  });
  it("splitRosterSuffix returns all four regions", () => {
    expect(splitRosterSuffix(full)).toEqual({ body, rosterLine: roster, droneLine: drone, linksLine: links });
  });
  it("splitRosterSuffix: 🔗 directly after the crew line (no 🛸)", () => {
    expect(splitRosterSuffix([body, roster, links].join("\n"))).toEqual({ body, rosterLine: roster, droneLine: null, linksLine: links });
  });
  it("parseRosterSuffix reads the same crew with or without a trailing 🔗 line", () => {
    expect(parseRosterSuffix(full)).toEqual(parseRosterSuffix([body, roster, drone].join("\n")));
    expect(parseRosterSuffix(full).length).toBe(2);
  });
});
