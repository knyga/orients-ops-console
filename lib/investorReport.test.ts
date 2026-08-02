import { describe, expect, it } from "vitest";
import {
  buildInvestorPrompt,
  buildWeekData,
  computeWeekWindow,
  fallbackSummary,
  formatInvestorMessage,
  formatWeekLabel,
  monthKeysCovering,
  pickSprintCompletion,
  toInvestorCsv,
  type InvestorWeekData,
} from "./investorReport";

// -- fixtures ---------------------------------------------------------------

const DATA: InvestorWeekData = {
  window: { start: "2026-07-20", end: "2026-07-26", key: "2026-07-20_2026-07-26" },
  jira: {
    resolved: 12,
    storyPoints: 34,
    noteworthy: [{ key: "ATP-101", summary: "Автопілот: утримання висоти" }],
  },
  sprint: { name: "ATP 42", rate: 80, completed: 8, committed: 10 },
  field: { reports: 3, accepted: 2, flagged: 1, fieldHours: 14.5, airHours: 6.2, flightDays: 3 },
  video: { count: 9, minutes: 187 },
  datasets: { noticeDays: 2 },
};

describe("computeWeekWindow", () => {
  it("returns the previous Mon–Sun for a mid-week Tuesday", () => {
    expect(computeWeekWindow("2026-08-04")).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
      key: "2026-07-27_2026-08-02",
    });
  });

  it("on a Monday returns the week that ended yesterday", () => {
    expect(computeWeekWindow("2026-08-03")).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
      key: "2026-07-27_2026-08-02",
    });
  });

  it("on a Sunday returns the previous full week, not the ending one", () => {
    // Sunday 2026-08-09: current week (Aug 3–9) is not over yet.
    expect(computeWeekWindow("2026-08-09").end).toBe("2026-08-02");
  });

  it("handles a year boundary", () => {
    // Tuesday 2027-01-05 → previous week Mon 2026-12-28 .. Sun 2027-01-03.
    expect(computeWeekWindow("2027-01-05")).toEqual({
      start: "2026-12-28",
      end: "2027-01-03",
      key: "2026-12-28_2027-01-03",
    });
  });

  it("never collapses the key to YYYY-MM even inside one month", () => {
    // Tue 2026-07-14 → Mon 2026-07-06 .. Sun 2026-07-12, same month.
    expect(computeWeekWindow("2026-07-14").key).toBe("2026-07-06_2026-07-12");
  });

  it("is unaffected by the Kyiv DST transition (2026-10-25)", () => {
    // Kyiv DST ended Sun 2026-10-25; the UTC date-only math must not drift.
    expect(computeWeekWindow("2026-10-27")).toEqual({
      start: "2026-10-19",
      end: "2026-10-25",
      key: "2026-10-19_2026-10-25",
    });
  });
});

describe("monthKeysCovering", () => {
  it("returns one month for an in-month week", () => {
    expect(monthKeysCovering({ start: "2026-07-06", end: "2026-07-12", key: "x" }))
      .toEqual(["2026-07"]);
  });
  it("returns both months for a straddling week", () => {
    expect(monthKeysCovering({ start: "2026-07-27", end: "2026-08-02", key: "x" }))
      .toEqual(["2026-07", "2026-08"]);
  });
});

describe("formatWeekLabel", () => {
  it("renders an in-month week compactly", () => {
    expect(formatWeekLabel("2026-07-20", "2026-07-26")).toBe("20–26 липня 2026");
  });
  it("renders a cross-month week with both months", () => {
    expect(formatWeekLabel("2026-07-27", "2026-08-02")).toBe("27 липня – 2 серпня 2026");
  });
  it("renders a cross-year week with both years", () => {
    expect(formatWeekLabel("2026-12-28", "2027-01-03")).toBe("28 грудня 2026 – 3 січня 2027");
  });
});

describe("buildWeekData", () => {
  const window = { start: "2026-07-20", end: "2026-07-26", key: "2026-07-20_2026-07-26" };

  it("slices field rows to the window and aggregates", () => {
    const data = buildWeekData({
      window,
      jiraTotals: { totalResolved: 12, totalStoryPoints: 34 },
      noteworthy: [{ key: "ATP-101", summary: "Автопілот" }],
      sprint: null,
      fieldQaDays: [
        { date: "2026-07-19", airborneMinutes: 999, flew: true },  // before window — dropped
        { date: "2026-07-21", airborneMinutes: 120, flew: true },
        { date: "2026-07-22", airborneMinutes: 252, flew: true },
        { date: "2026-07-23", airborneMinutes: 0, flew: false },   // no flight — not a flight day
      ],
      verdictDays: [
        { date: "2026-07-21", reportTs: "1.1", status: "ACCEPTED", datasetStatus: "POSTED", deployMin: 480, hasZvit: true },
        { date: "2026-07-22", reportTs: "2.1", status: "ACCEPTED_EXCEPTION", datasetStatus: "POSTED", deployMin: 240, hasZvit: true },
        { date: "2026-07-22", reportTs: "2.2", status: "NEEDS_REVIEW", datasetStatus: "POSTED", deployMin: 150, hasZvit: true },
        { date: "2026-07-27", reportTs: "9.9", status: "ACCEPTED", datasetStatus: "POSTED", deployMin: 480, hasZvit: true }, // after window — dropped
      ],
      videos: [{ duration: 600 }, { duration: 300 }],
    });

    expect(data.field).toEqual({
      reports: 3,
      accepted: 2,     // ACCEPTED + ACCEPTED_EXCEPTION
      flagged: 1,      // NEEDS_REVIEW (PENDING would count too)
      fieldHours: 14.5, // (480+240+150)/60
      airHours: 6.2,    // (120+252)/60
      flightDays: 2,
    });
    expect(data.video).toEqual({ count: 2, minutes: 15 });
    expect(data.datasets.noticeDays).toBe(2); // 07-21 and 07-22, per-date dedupe
  });

  it("ignores synthetic no-Звіт rows and null deployMin in the field-hours sum", () => {
    const data = buildWeekData({
      window,
      jiraTotals: { totalResolved: 0, totalStoryPoints: 0 },
      noteworthy: [],
      sprint: null,
      fieldQaDays: [],
      verdictDays: [
        { date: "2026-07-21", reportTs: null, status: "NEEDS_REVIEW", datasetStatus: "MISSING", deployMin: null, hasZvit: false },
        { date: "2026-07-22", reportTs: "3.1", status: "PENDING", datasetStatus: "MISSING", deployMin: null, hasZvit: true },
      ],
      videos: [],
    });
    expect(data.field.reports).toBe(1);      // hasZvit false excluded
    expect(data.field.flagged).toBe(1);      // PENDING counts as flagged
    expect(data.field.fieldHours).toBe(0);   // null deployMin contributes nothing
    expect(data.datasets.noticeDays).toBe(0);
  });
});

describe("pickSprintCompletion", () => {
  const window = { start: "2026-07-20", end: "2026-07-26", key: "k" };
  it("picks the newest completed sprint whose computedAt falls in the window (+2d tolerance)", () => {
    const picked = pickSprintCompletion(
      [
        { name: "ATP 43", computedAt: "2026-08-02T20:00:00Z", rate: 50, completed: 5, committed: 10 },
        { name: "ATP 42", computedAt: "2026-07-26T20:00:00Z", rate: 80, completed: 8, committed: 10 },
      ],
      window,
    );
    expect(picked).toEqual({ name: "ATP 42", rate: 80, completed: 8, committed: 10 });
  });
  it("returns null when nothing matches", () => {
    expect(pickSprintCompletion([], window)).toBeNull();
  });
});

describe("formatInvestorMessage", () => {
  it("puts the summary first, then the three bullet blocks", () => {
    const msg = formatInvestorMessage("Гарний тиждень.", DATA);
    expect(msg).toContain("📊 Тижневий звіт для інвесторів — 20–26 липня 2026");
    expect(msg.indexOf("Гарний тиждень.")).toBeLessThan(msg.indexOf("🛠 Розробка"));
    expect(msg).toContain("• Закрито 12 задач (34 стор-поїнтів)");
    expect(msg).toContain("• Виконання спринту: 80% (8/10)");
    expect(msg).toContain("🚁 Польові роботи");
    expect(msg).toContain("• Виїздів: 3 (прийнято 2, на розгляді 1)");
    expect(msg).toContain("• Час у полі: 14.5 год, час у повітрі: 6.2 год");
    expect(msg).toContain("🎥 Дані");
    expect(msg).toContain("• Відео: 9 роликів, 187 хв записано");
    expect(msg).toContain("• Датасети: передано за 2 дн.");
  });

  it("omits the sprint line when sprint is null and shows an honest zero-field week", () => {
    const data: InvestorWeekData = {
      ...DATA,
      sprint: null,
      field: { reports: 0, accepted: 0, flagged: 0, fieldHours: 0, airHours: 0, flightDays: 0 },
    };
    const msg = formatInvestorMessage("X.", data);
    expect(msg).not.toContain("Виконання спринту");
    expect(msg).toContain("• Виїздів: 0");
  });
});

describe("fallbackSummary / buildInvestorPrompt", () => {
  it("fallback mentions the headline numbers", () => {
    const s = fallbackSummary(DATA);
    expect(s).toContain("12");
    expect(s).toContain("3");
  });
  it("prompt embeds the numbers and the noteworthy issue titles", () => {
    const p = buildInvestorPrompt(DATA);
    expect(p).toContain('"resolved": 12');
    expect(p).toContain("Автопілот: утримання висоти");
  });
});

describe("toInvestorCsv", () => {
  it("emits one header + one data row", () => {
    const lines = toInvestorCsv(DATA).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "start,end,jira_resolved,jira_story_points,sprint_rate,field_reports,field_accepted,field_flagged,field_hours,air_hours,video_count,video_minutes,dataset_days",
    );
    expect(lines[1]).toBe("2026-07-20,2026-07-26,12,34,80,3,2,1,14.5,6.2,9,187,2");
  });
});
