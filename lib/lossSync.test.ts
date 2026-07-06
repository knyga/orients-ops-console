import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LossRow } from "./lossLedger";

const mocks = vi.hoisted(() => ({
  extractLoss: vi.fn(),
  readLossRecords: vi.fn(),
  upsertLossRecord: vi.fn(),
  readChannelMessages: vi.fn(),
  readAliases: vi.fn(),
}));
vi.mock("./lossExtract", () => ({ extractLoss: mocks.extractLoss }));
vi.mock("./lossStore", () => ({
  readLossRecords: mocks.readLossRecords,
  upsertLossRecord: mocks.upsertLossRecord,
}));
vi.mock("./slackMirror", () => ({ readChannelMessages: mocks.readChannelMessages }));
vi.mock("./rosterAliases", () => ({
  readAliases: mocks.readAliases,
  mergeAliases: (a: Record<string, string>, b: Record<string, string>) => ({ ...a, ...b }),
}));

import { crashHash, syncLossLedger } from "./lossSync";

const JULY = { start: "2026-07-01", end: "2026-07-31", timezone: "Europe/Kyiv" };
// A parseable Звіт: date line, roster+window line, then crash text.
const ZVIT = "04.07.2026\nАндріан+Данило 10:00-16:00\nвтрата борта (думаю знайдем)";
const msg = { text: ZVIT, permalink: "p", ts: "111.222" };

const ledgerRow = (over: Partial<LossRow>): LossRow => ({
  date: "2026-07-04",
  reportTs: "111.222",
  lost: true,
  found: false,
  note: "втрата борта",
  source: "extracted",
  crashTextHash: crashHash("втрата борта (думаю знайдем)"),
  updatedAt: "2026-07-05T00:00:00Z",
  updatedBy: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAliases.mockResolvedValue({});
  mocks.readChannelMessages.mockResolvedValue([msg]);
  mocks.upsertLossRecord.mockResolvedValue(true);
  mocks.extractLoss.mockResolvedValue({ lost: true, found: false, note: "втрата борта" });
});

describe("syncLossLedger", () => {
  it("classifies a Звіт with no ledger row and upserts it (including lost=false)", async () => {
    mocks.readLossRecords.mockResolvedValue([]);
    mocks.extractLoss.mockResolvedValue({ lost: false, found: false, note: "" });
    const result = await syncLossLedger(JULY);
    expect(mocks.extractLoss).toHaveBeenCalledOnce();
    expect(mocks.upsertLossRecord).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-07-04", reportTs: "111.222", lost: false, source: "extracted" }),
    );
    expect(result.classified).toBe(1);
    expect(result.failed).toBe(0);
  });
  it("skips an unchanged crash text (hash gate) — zero Claude calls", async () => {
    mocks.readLossRecords.mockResolvedValue([ledgerRow({})]);
    const result = await syncLossLedger(JULY);
    expect(mocks.extractLoss).not.toHaveBeenCalled();
    expect(mocks.upsertLossRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({ classified: 0, failed: 0 });
  });
  it("re-classifies when the Звіт crash text was edited", async () => {
    mocks.readLossRecords.mockResolvedValue([ledgerRow({ crashTextHash: "stale-hash" })]);
    const result = await syncLossLedger(JULY);
    expect(mocks.extractLoss).toHaveBeenCalledOnce();
    expect(result.classified).toBe(1);
  });
  it("never touches an instruction row", async () => {
    mocks.readLossRecords.mockResolvedValue([ledgerRow({ source: "instruction", crashTextHash: null })]);
    const result = await syncLossLedger(JULY);
    expect(mocks.extractLoss).not.toHaveBeenCalled();
    expect(mocks.upsertLossRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({ classified: 0, failed: 0 });
  });
  it("a classifier failure on one Звіт keeps the old row, continues, and is counted in `failed`", async () => {
    mocks.readLossRecords.mockResolvedValue([]);
    mocks.extractLoss.mockRejectedValue(new Error("api down"));
    const result = await syncLossLedger(JULY);
    expect(mocks.upsertLossRecord).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.classified).toBe(0);
    expect(result.failed).toBe(1);
  });
});
