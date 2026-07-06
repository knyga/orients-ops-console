import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  syncAllChannels,
  extractFieldQa,
  computeVerdicts,
  publishSettledDays,
  refreshPublishedDays,
  openDm,
  postMessage,
  readReportJson,
  syncLossLedger,
  readLossAlertState,
  writeLossAlertState,
} = vi.hoisted(() => ({
  syncAllChannels: vi.fn(),
  extractFieldQa: vi.fn(),
  computeVerdicts: vi.fn(),
  publishSettledDays: vi.fn(),
  refreshPublishedDays: vi.fn(),
  openDm: vi.fn(),
  postMessage: vi.fn(),
  readReportJson: vi.fn(),
  syncLossLedger: vi.fn(),
  readLossAlertState: vi.fn(),
  writeLossAlertState: vi.fn(),
}));

vi.mock("./syncChannels", () => ({ syncAllChannels, todayInFieldTz: () => "2026-07-15" }));
vi.mock("./fieldQaExtract", () => ({ extractFieldQa }));
vi.mock("./computeVerdicts", () => ({ computeVerdicts }));
vi.mock("./publishVerdicts", () => ({ publishSettledDays }));
vi.mock("./refreshPublished", () => ({ refreshPublishedDays }));
vi.mock("./slack", () => ({ openDm, postMessage }));
vi.mock("./lossSync", () => ({ syncLossLedger }));
vi.mock("./lossStore", () => ({ readLossAlertState, writeLossAlertState }));
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readReportJson }; // keep the real periodKey
});

import { runNightly } from "./runNightly";

beforeEach(() => {
  for (const m of [
    syncAllChannels,
    extractFieldQa,
    computeVerdicts,
    publishSettledDays,
    refreshPublishedDays,
    openDm,
    postMessage,
    readReportJson,
    syncLossLedger,
    readLossAlertState,
    writeLossAlertState,
  ])
    m.mockReset();
  readReportJson.mockResolvedValue(null); // default: no committed report → extract
  syncAllChannels.mockResolvedValue({ summaries: [], failures: 0 });
  extractFieldQa.mockResolvedValue({ days: [{ date: "2026-07-14" }], report: {} });
  computeVerdicts.mockResolvedValue({ days: [{ date: "2026-07-14", status: "ACCEPTED" }], summary: {} });
  publishSettledDays.mockResolvedValue({ posted: ["2026-07-14"], skipped: [] });
  refreshPublishedDays.mockResolvedValue({ refreshed: [], skipped: [] });
  openDm.mockResolvedValue("D0OPERATOR");
  postMessage.mockResolvedValue("1.1");
  syncLossLedger.mockResolvedValue({ rows: [], classified: 0, failed: 0 }); // no loss rows/failures → no alerts, keeps existing DM assertions intact
  readLossAlertState.mockResolvedValue(null);
  writeLossAlertState.mockResolvedValue(undefined);
});

describe("runNightly", () => {
  it("mid-month: syncs once (datasets only), processes the current month, publishes when publish=true", async () => {
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(syncAllChannels).toHaveBeenCalledOnce();
    expect(syncAllChannels).toHaveBeenCalledWith(
      expect.objectContaining({ channels: [{ id: "C08KG802THU", name: "datasets" }] }),
    );
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

  it("boundary with no cached report: extracts previous + current month (2 iterations)", async () => {
    await runNightly({ publish: true, today: "2026-07-02" });
    expect(extractFieldQa).toHaveBeenCalledTimes(2);
    expect(computeVerdicts).toHaveBeenCalledTimes(2);
  });

  it("boundary with cached catch-up reports: reuses them and skips both re-extraction and recompute", async () => {
    // Previous month (2026-06) already has committed field-qa + field-verdict reports; current (2026-07) does not.
    readReportJson.mockImplementation(async (_feature: string, key: string) =>
      key === "2026-06" ? { days: [{}, {}, {}] } : null,
    );
    const res = await runNightly({ publish: true, today: "2026-07-02" });
    expect(extractFieldQa).toHaveBeenCalledTimes(1); // only the newest (current) month
    expect(computeVerdicts).toHaveBeenCalledTimes(1); // June's verdict is reused, not recomputed
    expect(publishSettledDays).toHaveBeenCalledTimes(2); // both months still publish (catch-up preserved)
    const june = res.months.find((m) => m.period.start === "2026-06-01");
    expect(june?.extractedDays).toBe(3); // day count came from the reused field-qa report
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

  it("publish: refreshes published entries after publishing and surfaces the keys", async () => {
    refreshPublishedDays.mockResolvedValue({ refreshed: ["2026-07-10"], skipped: [] });
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(refreshPublishedDays).toHaveBeenCalledOnce();
    const [days, period, opts] = refreshPublishedDays.mock.calls[0];
    expect(days).toBe((await computeVerdicts.mock.results[0].value).days); // the fresh verdict report's days
    expect(period).toMatchObject({ start: "2026-07-01" });
    expect(opts?.dryRun).toBeFalsy();
    expect(opts?.runDate).toBe("2026-07-15");
    expect(res.months[0].refreshed).toEqual(["2026-07-10"]);
    // Refresh reads the published log AFTER publishing has (idempotently) recorded
    // today's posts — running it first could refresh against a stale log.
    expect(publishSettledDays.mock.invocationCallOrder[0]).toBeLessThan(refreshPublishedDays.mock.invocationCallOrder[0]);
  });

  it("dry-run: plans the refresh without editing (dryRun: true)", async () => {
    await runNightly({ publish: false, today: "2026-07-15" });
    expect(refreshPublishedDays).toHaveBeenCalledOnce();
    expect(refreshPublishedDays.mock.calls[0][2]).toMatchObject({ dryRun: true, runDate: "2026-07-15" });
  });

  describe("drone-loss stage", () => {
    it("a nonzero classify-failure count DMs the operator but the stage continues (no throw, still publishes)", async () => {
      syncLossLedger.mockResolvedValue({ rows: [], classified: 0, failed: 2 });
      const res = await runNightly({ publish: true, today: "2026-07-15" });
      expect(openDm).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledOnce();
      const [, text] = postMessage.mock.calls[0];
      expect(text).toContain("2");
      expect(res.months[0].posted).toEqual(["2026-07-14"]); // publish still ran
    });

    it("does not DM the operator on failed=0", async () => {
      syncLossLedger.mockResolvedValue({ rows: [], classified: 3, failed: 0 });
      await runNightly({ publish: true, today: "2026-07-15" });
      expect(postMessage).not.toHaveBeenCalled();
    });

    it("the loss-count operator DM key is salted with the run's Kyiv day (so a counter flip-flop re-sends)", async () => {
      const lossRow = {
        date: "2026-07-10",
        reportTs: "1.1",
        lost: true,
        found: false,
        note: "втрата борта",
        source: "extracted" as const,
        crashTextHash: "h",
        updatedAt: "2026-07-10T00:00:00Z",
        updatedBy: null,
      };
      syncLossLedger.mockResolvedValue({ rows: [lossRow], classified: 1, failed: 0 });
      readLossAlertState.mockResolvedValue(null); // prior count 0 → count 1 triggers an operator DM
      await runNightly({ publish: true, today: "2026-07-15" });
      const dmCall = postMessage.mock.calls.find((c) => typeof c[2]?.key === "string" && c[2].key.startsWith("loss-alert:"));
      expect(dmCall?.[2].key).toBe("loss-alert:2026-07:1:2026-07-15");
    });
  });
});
