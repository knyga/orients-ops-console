import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  computeVerdicts: vi.fn(),
  readChannelMessages: vi.fn(async () => []),
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
      { date: "2026-06-02", status: "ACCEPTED", roster: ["Андріан"], unknownInitials: [], deployMin: 270,
        videoMinutes: 44.8, airborneMinutes: 55, airborneReported: true, reasons: [], ratio: 0.8,
        datasetStatus: "POSTED", withinGrace: false },
      { date: "2026-06-27", status: "NEEDS_REVIEW", roster: ["Сергій"], unknownInitials: [], deployMin: 180,
        videoMinutes: 30, airborneMinutes: 7.8, airborneReported: true, reasons: ["no #datasets notice for the day"],
        ratio: 3.8, datasetStatus: "MISSING", withinGrace: false },
    ]});
    const report = await computeBonusReport({ start: "2026-06-01", end: "2026-06-30" });
    expect(report.people.map((p) => p.name)).toEqual(["Андріан"]);
    expect(report.pendingDays.map((d) => d.date)).toEqual(["2026-06-27"]);
  });
});
