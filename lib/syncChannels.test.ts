import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  fetchRawMessages,
  readSyncCursor,
  readMonthFile,
  writeMonthFile,
  writeSyncCursor,
  mergeMessages,
  upsertMessages,
  monthsInPeriod,
} = vi.hoisted(() => ({
  fetchRawMessages: vi.fn(),
  readSyncCursor: vi.fn(),
  readMonthFile: vi.fn(),
  writeMonthFile: vi.fn(),
  writeSyncCursor: vi.fn(),
  mergeMessages: vi.fn(),
  upsertMessages: vi.fn(),
  monthsInPeriod: vi.fn(),
}));

vi.mock("./slack", () => ({ fetchRawMessages }));
vi.mock("./slackMirror", () => ({
  readSyncCursor,
  readMonthFile,
  writeMonthFile,
  writeSyncCursor,
  mergeMessages,
  upsertMessages,
  monthsInPeriod,
}));

import { syncAllChannels } from "./syncChannels";

const chans = [
  { id: "C1", name: "alpha" },
  { id: "C2", name: "beta" },
  { id: "C3", name: "gamma" },
];

beforeEach(() => {
  for (const m of [
    fetchRawMessages,
    readSyncCursor,
    readMonthFile,
    writeMonthFile,
    writeSyncCursor,
    mergeMessages,
    upsertMessages,
    monthsInPeriod,
  ])
    m.mockReset();
  readSyncCursor.mockResolvedValue({ lastSync: "2026-07-01T00:00:00.000Z" }); // incremental path
  fetchRawMessages.mockResolvedValue([]);
  readMonthFile.mockResolvedValue(null);
  writeMonthFile.mockResolvedValue(undefined);
  writeSyncCursor.mockResolvedValue(undefined);
  mergeMessages.mockReturnValue({});
  upsertMessages.mockReturnValue({});
  monthsInPeriod.mockReturnValue([]);
});

describe("syncAllChannels", () => {
  it("syncs every channel and preserves summary order", async () => {
    const res = await syncAllChannels({ mode: "incremental", window: 7, channels: chans });
    expect(res.summaries.map((s) => s.channel)).toEqual(["alpha", "beta", "gamma"]);
    expect(res.failures).toBe(0);
    expect(fetchRawMessages).toHaveBeenCalledTimes(3);
  });

  it("isolates a channel failure — the others still sync", async () => {
    fetchRawMessages.mockImplementation(async (_period: unknown, [channel]: { name: string }[]) => {
      if (channel.name === "beta") throw new Error("beta boom");
      return [];
    });
    const res = await syncAllChannels({ mode: "incremental", window: 7, channels: chans });
    expect(res.failures).toBe(1);
    expect(res.summaries.find((s) => s.channel === "beta")?.error).toContain("beta boom");
    expect(res.summaries.filter((s) => !s.error).map((s) => s.channel)).toEqual(["alpha", "gamma"]);
  });

  it("syncs channels concurrently (all fetches overlap, not one-at-a-time)", async () => {
    let active = 0;
    let maxActive = 0;
    fetchRawMessages.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return [];
    });
    await syncAllChannels({ mode: "incremental", window: 7, channels: chans });
    expect(maxActive).toBeGreaterThan(1); // sequential would cap maxActive at 1
  });
});
