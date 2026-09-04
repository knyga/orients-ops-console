import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderVerdictStatus } from "./fieldVerdict";
import type { DayVerdict } from "@/lib/fieldDayVerdict";

const d: DayVerdict = {
  date: "2026-09-01", reportTs: "1781000000.000100", reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW", airborneMinutes: 120, videoMinutes: 48, ratio: 0.4,
  datasetStatus: "MISSING", withinGrace: false, reasons: [], roster: ["Тарас", "Влад"], unknownInitials: [], airborneReported: true, deployMin: 300, deployWindow: { start: "09:00", end: "14:00" },
};

describe("renderVerdictStatus", () => {
  const prevWorkspace = process.env.SLACK_WORKSPACE;
  beforeEach(() => {
    delete process.env.SLACK_WORKSPACE;
  });
  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.SLACK_WORKSPACE;
    else process.env.SLACK_WORKSPACE = prevWorkspace;
  });

  it("renders status, gaps, numbers, crew and a Звіт link per report", () => {
    const t = renderVerdictStatus([d], "2026-09-01", "C08GY2NKF9D");
    expect(t).toContain("NEEDS_REVIEW");
    expect(t).toContain("потрібна перевірка");
    expect(t).toContain("відео 48 хв");
    expect(t).toContain("немає повідомлення про датасет");
    expect(t).toContain("Тарас, Влад");
    expect(t).toContain("archives/C08GY2NKF9D/p1781000000000100");
    expect(t).toMatch(/https:\/\/orientsai\.slack\.com\//);
  });
  it("says so when the date has no verdict", () => {
    expect(renderVerdictStatus([], "2026-09-02", "C")).toContain("немає вердикту");
  });
});
