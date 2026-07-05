import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  computeVerdicts: vi.fn(),
  readChannelMessages: vi.fn(async (): Promise<{ text: string; permalink: string; ts: string }[]> => []),
  extractLoss: vi.fn(),
  readAliases: vi.fn(),
  readRosterCorrections: vi.fn(),
  writeReport: vi.fn(),
}));
vi.mock("./computeVerdicts", () => ({ computeVerdicts: mocks.computeVerdicts, todayInFieldTz: () => "2026-07-03" }));
vi.mock("./slackMirror", () => ({ readChannelMessages: mocks.readChannelMessages }));
vi.mock("./lossExtract", () => ({ extractLoss: mocks.extractLoss }));
vi.mock("./rosterAliases", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readAliases: mocks.readAliases };
});
vi.mock("./rosterCorrections", () => ({ readRosterCorrections: mocks.readRosterCorrections }));
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writeReport: mocks.writeReport };
});

import { computeBonusReport } from "./computeBonuses";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readChannelMessages.mockResolvedValue([]);
  mocks.readAliases.mockResolvedValue({});
  mocks.readRosterCorrections.mockResolvedValue([]);
  mocks.extractLoss.mockResolvedValue({ lost: false, found: false, note: "" });
  mocks.writeReport.mockResolvedValue({ key: "2026-06" });
});

describe("computeBonusReport", () => {
  it("maps verdict days to qualified days and pays accepted ones", async () => {
    mocks.computeVerdicts.mockResolvedValue({ days: [
      { date: "2026-06-02", reportTs: null, reportCount: 1, status: "ACCEPTED", roster: ["Андріан"], unknownInitials: [], deployMin: 270,
        videoMinutes: 44.8, airborneMinutes: 55, airborneReported: true, reasons: [], ratio: 0.8,
        datasetStatus: "POSTED", withinGrace: false },
      { date: "2026-06-27", reportTs: null, reportCount: 1, status: "NEEDS_REVIEW", roster: ["Сергій"], unknownInitials: [], deployMin: 180,
        videoMinutes: 30, airborneMinutes: 7.8, airborneReported: true, reasons: ["no #datasets notice for the day"],
        ratio: 3.8, datasetStatus: "MISSING", withinGrace: false },
    ]});
    const report = await computeBonusReport({ start: "2026-06-01", end: "2026-06-30" });
    expect(report.people.map((p) => p.name)).toEqual(["Андріан"]);
    expect(report.pendingDays.map((d) => d.date)).toEqual(["2026-06-27"]);
  });

  it("counts a 0-airborne day with a known deploy window as flight evidence for pendingDays", async () => {
    mocks.computeVerdicts.mockResolvedValue({ days: [
      { date: "2026-06-26", reportTs: null, reportCount: 1, status: "NEEDS_REVIEW", roster: ["Андріан", "Надія"], unknownInitials: [],
        deployMin: 200, videoMinutes: 36.7, airborneMinutes: 0, airborneReported: true,
        reasons: ["drones did not fly (0 flights, 0 min airborne)"], ratio: null,
        datasetStatus: "POSTED", withinGrace: false },
    ]});
    const report = await computeBonusReport({ start: "2026-06-01", end: "2026-06-30" });
    const pending = report.pendingDays.find((d) => d.date === "2026-06-26");
    expect(pending?.amountAtStake).toBe(1400);
  });

  it("takes the early-bonus start time from each report's own Звіт on a two-report day", async () => {
    // Two Звіт messages, same date, different crews/starts: parseMonth (real,
    // not mocked) resolves them to two distinct FieldReports keyed by reportTs.
    mocks.readChannelMessages.mockResolvedValue([
      { text: "Звіт 01.07.2026\nА+Н 07:30-11:10", permalink: "p1", ts: "1782912665.697519" },
      { text: "Звіт 01.07.2026\nВ+Н 18:20-20:10", permalink: "p2", ts: "1782927922.936129" },
    ]);
    mocks.computeVerdicts.mockResolvedValue({ days: [
      { date: "2026-07-01", reportTs: "1782912665.697519", reportCount: 2, status: "ACCEPTED",
        roster: ["Андріан", "Надія"], unknownInitials: [], deployMin: 220,
        videoMinutes: 120, airborneMinutes: 200, airborneReported: true, reasons: [], ratio: 0.9,
        datasetStatus: "POSTED", withinGrace: false },
      { date: "2026-07-01", reportTs: "1782927922.936129", reportCount: 2, status: "ACCEPTED",
        roster: ["Влад", "Надія"], unknownInitials: [], deployMin: 110,
        videoMinutes: 60, airborneMinutes: 100, airborneReported: true, reasons: [], ratio: 0.9,
        datasetStatus: "POSTED", withinGrace: false },
    ]});
    const report = await computeBonusReport({ start: "2026-07-01", end: "2026-07-31" });
    // First report started 07:30 (early); second started 18:20 (not early).
    expect(report.people.find((p) => p.name === "Андріан")?.early).toBe(1);
    expect(report.people.find((p) => p.name === "Влад")?.early).toBe(0);
    expect(report.people.find((p) => p.name === "Надія")?.early).toBe(1); // earns early once, on the qualifying report
  });
});
