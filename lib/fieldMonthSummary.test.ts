import { describe, expect, it } from "vitest";
import { buildMonthSummary, formatDayLine, reasonUk, type SummaryDay } from "./fieldMonthSummary";

const base: SummaryDay = {
  date: "2026-08-19",
  roster: ["Андріан", "Влад"],
  deployWindow: { start: "15:00", end: "18:45" },
  deployMin: 225,
  airborneMinutes: 41,
  airborneReported: true,
  videoMinutes: 100.4,
  status: "ACCEPTED",
  early: false,
  weekend: false,
  droneCounts: [{ name: "Андріан", count: 4 }, { name: "Влад", count: 3 }],
  droneReportKnown: true,
  gateExcluded: [],
  notCounted: [],
  approver: null,
  reasons: [],
  hasZvit: true,
  verdictUrl: "https://slack/v19",
  zvitUrl: "https://slack/z19",
};

describe("formatDayLine", () => {
  it("renders an accepted day: date+weekday, crew, window, deploy, airborne, drones, ✅, links", () => {
    const line = formatDayLine(base);
    expect(line).toContain("19.08 ср");
    expect(line).toContain("Андріан + Влад");
    expect(line).toContain("15:00–18:45");
    expect(line).toContain("3 год 45 хв");
    expect(line).toContain("у повітрі 41 хв");
    expect(line).toContain("дрони: Андріан 4, Влад 3");
    expect(line).toContain("✅ прийнято");
    expect(line).toContain("<https://slack/v19|вердикт>");
    expect(line).toContain("<https://slack/z19|звіт>");
    expect(line).not.toContain("₴"); // never money in the team-facing summary
  });

  it("marks early departure and weekend", () => {
    const line = formatDayLine({ ...base, date: "2026-08-22", early: true, weekend: true });
    expect(line).toContain("22.08 сб");
    expect(line).toContain("ранній виїзд");
    expect(line).toContain("вихідний");
  });

  it("an approver exception is ✅ with the approver's name, and gate exclusions are named", () => {
    const line = formatDayLine({
      ...base,
      status: "ACCEPTED_EXCEPTION",
      approver: "Oleksandr K",
      gateExcluded: ["Влад"],
      droneCounts: [{ name: "Андріан", count: 4 }],
    });
    expect(line).toContain("✅ прийнято (виняток, Oleksandr K)");
    expect(line).toContain("без свого звіту дронів: Влад");
    expect(line).not.toContain("🟡");
  });

  it("a rejected day shows ⛔ with the approver; a review day shows ⚠️ with the machine reasons in Ukrainian", () => {
    expect(formatDayLine({ ...base, status: "REJECTED", approver: "Oleksandr K", roster: [], deployWindow: null, deployMin: null, hasZvit: false })).toContain(
      "⛔ відхилено (Oleksandr K)",
    );
    const review = formatDayLine({
      ...base,
      status: "NEEDS_REVIEW",
      airborneMinutes: 0,
      reasons: ["drones did not fly (0 flights, 0 min airborne)"],
    });
    expect(review).toContain("⚠️ на перевірці");
    expect(review).toContain("за телеметрією польотів не було");
  });

  it("a day with no Звіт and no crew renders dashes, not empty cells", () => {
    const line = formatDayLine({
      ...base,
      roster: [],
      deployWindow: null,
      deployMin: null,
      hasZvit: false,
      zvitUrl: null,
      droneCounts: [],
      status: "NEEDS_REVIEW",
      reasons: ["flight detected but no Звіт (crew/deployment unknown)"],
    });
    expect(line).toContain("екіпаж —");
    expect(line).toContain("дрони: —");
    expect(line).toContain("немає Звіту");
    expect(line).not.toContain("|звіт>");
  });

  it("unrecorded airborne time says so instead of 0", () => {
    expect(formatDayLine({ ...base, airborneReported: false, airborneMinutes: 0 })).toContain("у повітрі — не вказано");
  });
});

describe("buildMonthSummary — anchor + thread replies (sprint-post shape)", () => {
  const days = [
    { ...base, date: "2026-08-20" },
    base,
    { ...base, date: "2026-08-05", status: "REJECTED" as const, approver: "Oleksandr K" },
    { ...base, date: "2026-08-13", status: "NEEDS_REVIEW" as const, reasons: ["drones did not fly (0 flights, 0 min airborne)"] },
    { ...base, date: "2026-08-31", status: "PENDING" as const },
  ];

  it("anchor: Ukrainian header with month + as-of date, status counts, legend — and NO per-day lines", () => {
    const { anchor } = buildMonthSummary({ start: "2026-08-01", end: "2026-08-31" }, "2026-09-03", days);
    expect(anchor.startsWith("*Польові дні — серпень 2026*")).toBe(true);
    expect(anchor).toContain("станом на 03.09");
    expect(anchor).toContain("✅ 2");
    expect(anchor).toContain("⚠️ 1");
    expect(anchor).toContain("⛔ 1");
    expect(anchor).toContain("⏳ 1");
    expect(anchor).toContain("Деталі по днях — у треді");
    expect(anchor).not.toMatch(/\*\d\d\.\d\d /); // no day lines in the channel
  });

  it("details: every day as a thread line, sorted by date, packed under the Slack byte cap", () => {
    const { details } = buildMonthSummary({ start: "2026-08-01", end: "2026-08-31" }, "2026-09-03", days);
    const all = details.join("\n");
    expect(all.indexOf("05.08")).toBeLessThan(all.indexOf("13.08"));
    expect(all.indexOf("19.08")).toBeLessThan(all.indexOf("20.08"));
    expect(all.indexOf("20.08")).toBeLessThan(all.indexOf("31.08"));
    for (const d of details) expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(3800);
  });

  it("a month with many days spills into several thread replies, none over the cap, no day lost", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ ...base, date: `2026-08-${String(i + 1).padStart(2, "0")}` }));
    const { details } = buildMonthSummary({ start: "2026-08-01", end: "2026-08-31" }, "2026-09-03", many);
    expect(details.length).toBeGreaterThan(1);
    expect(details.join("\n").match(/^\*\d\d\.08/gm)?.length).toBe(31);
  });
});

describe("formatDayLine — reasons and labels", () => {
  it("a machine-rejected day (no approver) still shows WHY in Ukrainian", () => {
    const line = formatDayLine({ ...base, status: "REJECTED", approver: null, reasons: ["deployment 110m is under 3h"] });
    expect(line).toContain("⛔ відхилено");
    expect(line).toContain("менше 3 год");
  });
  it("translates the remaining machine reasons instead of leaking English", () => {
    expect(reasonUk("video 1.5m is under the 2-minute floor")).toMatch(/відео .*менше 2 хв/);
    expect(reasonUk("dataset reason declined by an admin")).toMatch(/датасет .*відхилено/);
    expect(reasonUk("drone lost and not recovered")).toMatch(/втрата борта/);
  });
  it("names crew not counted for the bonus for a non-gate reason, separately from the drone-gate line", () => {
    const line = formatDayLine({ ...base, gateExcluded: ["Андріан"], notCounted: ["Данило"] });
    expect(line).toContain("без свого звіту дронів: Андріан");
    expect(line).toContain("не зараховано до бонусу: Данило");
  });
  it("labels the report position on a multi-report day", () => {
    const line = formatDayLine({ ...base, reportSeq: 2, reportCount: 2 });
    expect(line).toContain("виїзд 2/2");
    expect(formatDayLine({ ...base, reportSeq: 1, reportCount: 1 })).not.toContain("виїзд 1/1");
  });
});

describe("buildMonthSummary — thread mode + oversize lines", () => {
  it("in thread mode the anchor points down the same thread, not to a thread of its own", () => {
    const { anchor } = buildMonthSummary({ start: "2026-08-01", end: "2026-08-31" }, "2026-09-03", [base], { inThread: true });
    expect(anchor).toContain("нижче");
    expect(anchor).not.toContain("у треді 👇");
  });
  it("a single line longer than the cap is split rather than dropped or sent oversized", () => {
    const huge = { ...base, roster: Array.from({ length: 400 }, (_, i) => `Пілот${i}`) };
    const { details } = buildMonthSummary({ start: "2026-08-01", end: "2026-08-31" }, "2026-09-03", [huge]);
    expect(details.length).toBeGreaterThan(1);
    for (const d of details) expect(new TextEncoder().encode(d).length).toBeLessThanOrEqual(3800);
    expect(details.join("")).toContain("Пілот399");
  });
});
