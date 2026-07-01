import { describe, it, expect, vi, beforeEach } from "vitest";

const { syncAllChannels, extractFieldQa, computeVerdicts, publishSettledDays, openDm, postMessage } = vi.hoisted(
  () => ({
    syncAllChannels: vi.fn(),
    extractFieldQa: vi.fn(),
    computeVerdicts: vi.fn(),
    publishSettledDays: vi.fn(),
    openDm: vi.fn(),
    postMessage: vi.fn(),
  }),
);

vi.mock("./syncChannels", () => ({ syncAllChannels, todayInFieldTz: () => "2026-07-15" }));
vi.mock("./fieldQaExtract", () => ({ extractFieldQa }));
vi.mock("./computeVerdicts", () => ({ computeVerdicts }));
vi.mock("./publishVerdicts", () => ({ publishSettledDays }));
vi.mock("./slack", () => ({ openDm, postMessage }));

import { runNightly } from "./runNightly";

beforeEach(() => {
  for (const m of [syncAllChannels, extractFieldQa, computeVerdicts, publishSettledDays, openDm, postMessage])
    m.mockReset();
  syncAllChannels.mockResolvedValue({ summaries: [], failures: 0 });
  extractFieldQa.mockResolvedValue({ days: [{ date: "2026-07-14" }], report: {} });
  computeVerdicts.mockResolvedValue({ days: [{ date: "2026-07-14", status: "ACCEPTED" }], summary: {} });
  publishSettledDays.mockResolvedValue({ posted: ["2026-07-14"], skipped: [] });
  openDm.mockResolvedValue("D0OPERATOR");
  postMessage.mockResolvedValue("1.1");
});

describe("runNightly", () => {
  it("mid-month: syncs once, processes the current month, publishes when publish=true", async () => {
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(syncAllChannels).toHaveBeenCalledOnce();
    expect(res.months).toHaveLength(1);
    expect(res.months[0].posted).toEqual(["2026-07-14"]);
    expect(publishSettledDays).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled(); // no failure/anomaly DM on success
  });

  it("dry-run: never publishes and never DMs", async () => {
    await runNightly({ publish: false, today: "2026-07-15" });
    expect(publishSettledDays).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("boundary: processes previous + current month (2 iterations)", async () => {
    await runNightly({ publish: true, today: "2026-07-02" });
    expect(extractFieldQa).toHaveBeenCalledTimes(2);
    expect(computeVerdicts).toHaveBeenCalledTimes(2);
  });

  it("short-circuits on extract failure: DMs the operator, does not publish, rethrows", async () => {
    extractFieldQa.mockRejectedValueOnce(new Error("boom"));
    await expect(runNightly({ publish: true, today: "2026-07-15" })).rejects.toThrow("boom");
    expect(publishSettledDays).not.toHaveBeenCalled();
    expect(openDm).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce(); // the failure DM
  });

  it("anomaly: extracted days but an empty verdict report DMs the operator without throwing", async () => {
    computeVerdicts.mockResolvedValue({ days: [], summary: {} });
    publishSettledDays.mockResolvedValue({ posted: [], skipped: [] });
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(res.months).toHaveLength(1);
    expect(openDm).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
  });
});
