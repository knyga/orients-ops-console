import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readLossRecords: vi.fn() }));
vi.mock("@/lib/lossStore", () => ({ readLossRecords: mocks.readLossRecords }));

import { fieldLossTools } from "./fieldLoss";

const tool = fieldLossTools[0];
const row = {
  date: "2026-07-04", reportTs: "111.222", lost: true, found: false, note: "втрата борта",
  source: "extracted" as const, crashTextHash: "h", updatedAt: "t", updatedBy: null,
};

beforeEach(() => vi.clearAllMocks());

describe("field_loss_status", () => {
  it("is a read tool named field_loss_status", () => {
    expect(tool.name).toBe("field_loss_status");
    expect(tool.kind).toBe("read");
  });
  it("reports losses, the counter, and the margin for an explicit period", async () => {
    mocks.readLossRecords.mockResolvedValue([row, { ...row, date: "2026-07-05", reportTs: "333.4" }]);
    const res = await tool.run!({ start: "2026-07-01", end: "2026-07-31" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("2026-07-04");
    expect(res.content).toContain("Невідновлених втрат: 2");
    expect(res.content).toContain("ліміт 3");
  });
  it("says there are no losses when the ledger is clean", async () => {
    mocks.readLossRecords.mockResolvedValue([]);
    const res = await tool.run!({ start: "2026-07-01", end: "2026-07-31" });
    expect(res.content).toContain("Втрат немає");
  });
});
