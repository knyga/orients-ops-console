import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  computeVerdicts: vi.fn(),
  readChannelMessages: vi.fn(async (): Promise<{ text: string; permalink: string; ts: string }[]> => []),
  syncLossLedger: vi.fn(),
  readAliases: vi.fn(),
  readRosterCorrections: vi.fn(),
  writeReport: vi.fn(),
}));
vi.mock("./computeVerdicts", () => ({ computeVerdicts: mocks.computeVerdicts, todayInFieldTz: () => "2026-07-03" }));
vi.mock("./slackMirror", () => ({ readChannelMessages: mocks.readChannelMessages }));
vi.mock("./lossSync", () => ({ syncLossLedger: mocks.syncLossLedger }));
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
  mocks.syncLossLedger.mockResolvedValue({ rows: [], classified: 0, failed: 0 });
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

  // Two counted trips for the same crew group; the ledger carries a loss on
  // each date. Two unrecovered losses inside the 12-trip window = the 50%
  // penalty tier, so these fixtures cross a real money threshold — the
  // assertions below genuinely discriminate (fail if the ledger were ignored).
  const twoTripDays = [
    { date: "2026-07-06", reportTs: "111.222", reportCount: 1, status: "ACCEPTED", roster: ["Андріан"], unknownInitials: [], deployMin: 200,
      videoMinutes: 40, airborneMinutes: 60, airborneReported: true, reasons: [], ratio: 0.9,
      datasetStatus: "POSTED", withinGrace: false },
    { date: "2026-07-08", reportTs: "333.444", reportCount: 1, status: "ACCEPTED", roster: ["Андріан"], unknownInitials: [], deployMin: 200,
      videoMinutes: 40, airborneMinutes: 60, airborneReported: true, reasons: [], ratio: 0.9,
      datasetStatus: "POSTED", withinGrace: false },
  ];
  const extractedLoss = (date: string, reportTs: string) =>
    ({ date, reportTs, lost: true, found: false, note: "втрата", source: "extracted" as const, crashTextHash: "h", updatedAt: "t", updatedBy: null });

  it("two unrecovered ledger losses in one group's 12-trip window halve the net", async () => {
    mocks.computeVerdicts.mockResolvedValue({ days: twoTripDays });
    mocks.syncLossLedger.mockResolvedValue({
      rows: [extractedLoss("2026-07-06", "111.222"), extractedLoss("2026-07-08", "333.444")],
      classified: 2,
      failed: 0,
    });
    const report = await computeBonusReport({ start: "2026-07-01", end: "2026-07-31" });
    expect(report.penalties).toEqual([expect.objectContaining({ group: ["Андріан"], lossesInWindow: 2, pct: 0.5 })]);
    const p = report.people.find((x) => x.name === "Андріан")!;
    expect(p.net).toBe(Math.round(p.gross * 0.5));
    expect(report.teamZeroed).toBe(false); // 2 lost dates <= TEAM_LOSS_CUTOFF
  });

  it("an instruction recovery in the ledger clears the loss for the money math", async () => {
    mocks.computeVerdicts.mockResolvedValue({ days: twoTripDays });
    mocks.syncLossLedger.mockResolvedValue({
      rows: [
        extractedLoss("2026-07-06", "111.222"),
        extractedLoss("2026-07-08", "333.444"),
        // Approver: the 07-08 drone was found — outranks the extracted row for
        // the same (date, reportTs), dropping the group to 1 loss (no penalty).
        { date: "2026-07-08", reportTs: "333.444", lost: true, found: true, note: "знайшли", source: "instruction", crashTextHash: null, updatedAt: "t2", updatedBy: "Oleksandr K" },
      ],
      classified: 2,
      failed: 0,
    });
    const report = await computeBonusReport({ start: "2026-07-01", end: "2026-07-31" });
    expect(report.teamZeroed).toBe(false);
    expect(report.penalties).toEqual([]);
    const p = report.people.find((x) => x.name === "Андріан")!;
    expect(p.net).toBe(p.gross); // no penalty applied
  });
});
