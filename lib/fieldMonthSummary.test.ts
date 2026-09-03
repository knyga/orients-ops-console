import { describe, expect, it } from "vitest";
import { buildMonthSummary, formatDayLine, type SummaryDay } from "./fieldMonthSummary";

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

describe("buildMonthSummary", () => {
  it("has a Ukrainian header with the month and as-of date, one line per day in order, and a legend", () => {
    const text = buildMonthSummary(
      { start: "2026-08-01", end: "2026-08-31" },
      "2026-09-03",
      [{ ...base, date: "2026-08-20" }, base],
    );
    expect(text.startsWith("*Польові дні — серпень 2026*")).toBe(true);
    expect(text).toContain("станом на 03.09");
    const i19 = text.indexOf("19.08");
    const i20 = text.indexOf("20.08");
    expect(i19).toBeGreaterThan(-1);
    expect(i20).toBeGreaterThan(i19); // sorted by date, not input order
    expect(text).toContain("✅ прийнято · ⚠️ на перевірці · ⛔ відхилено · ⏳ очікує");
  });
});
