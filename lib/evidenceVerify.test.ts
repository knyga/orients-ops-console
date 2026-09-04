import { describe, it, expect, vi, beforeEach } from "vitest";

const { syncAllChannels, computeVerdicts, refreshPublishedDays, readReportJson, fetchVideosInPeriod, readChannelMessages } = vi.hoisted(() => ({
  syncAllChannels: vi.fn(), computeVerdicts: vi.fn(), refreshPublishedDays: vi.fn(), readReportJson: vi.fn(), fetchVideosInPeriod: vi.fn(), readChannelMessages: vi.fn(),
}));
vi.mock("./syncChannels", () => ({ syncAllChannels }));
vi.mock("./computeVerdicts", () => ({ computeVerdicts }));
vi.mock("./refreshPublished", () => ({ refreshPublishedDays }));
vi.mock("./reports", async (orig) => ({ ...(await (orig as () => Promise<Record<string, unknown>>)()), readReportJson }));
vi.mock("./vimeo", () => ({ fetchVideosInPeriod }));
vi.mock("./slackMirror", () => ({ readChannelMessages }));

import { verifyEvidence } from "./evidenceVerify";

const period = { start: "2026-09-01", end: "2026-09-30" };
const noHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };
const row = (status: string, videoMinutes: number) => ({
  date: "2026-09-01", reportTs: "1.1", reportSeq: 1, reportCount: 1, status, airborneMinutes: 120, videoMinutes, ratio: videoMinutes / 120,
  datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: ["Тарас"], unknownInitials: [], airborneReported: true, deployMin: 300,
});

beforeEach(() => {
  syncAllChannels.mockReset().mockResolvedValue({});
  refreshPublishedDays.mockReset().mockResolvedValue({ refreshed: [], skipped: [] });
  // Feature-aware: "field-verdict" reads (the `before` lookup) get the row
  // fixture; "field-qa" reads (the guard) get a truthy stand-in so existing
  // tests exercise the sync/recompute/refresh path as before.
  readReportJson.mockReset().mockImplementation(async (feature: string) =>
    feature === "field-qa" ? { days: [{ date: "2026-09-01" }] } : { days: [row("NEEDS_REVIEW", 48)] },
  );
  computeVerdicts.mockReset().mockResolvedValue({ days: [row("ACCEPTED", 96)] });
  fetchVideosInPeriod.mockReset().mockResolvedValue([]);
  readChannelMessages.mockReset().mockResolvedValue([]);
});

describe("verifyEvidence", () => {
  it("syncs #datasets, recomputes with write, refreshes ONLY that day's rows, and reports before→after", async () => {
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(syncAllChannels).toHaveBeenCalledWith(expect.objectContaining({ mode: "incremental", channels: [expect.objectContaining({ name: "datasets" })] }));
    expect(computeVerdicts).toHaveBeenCalledWith(period, expect.objectContaining({ write: true }));
    const [days] = refreshPublishedDays.mock.calls[0];
    expect(days.map((d: { date: string }) => d.date)).toEqual(["2026-09-01"]);
    expect(r).toMatchObject({ outcome: "closed", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED" });
    expect(fetchVideosInPeriod).not.toHaveBeenCalled(); // no vimeo hints → no second fetch
  });
  it("fetches Vimeo only when a vimeo link was quoted, and resolves it by id", async () => {
    computeVerdicts.mockResolvedValue({ days: [row("NEEDS_REVIEW", 48)] });
    fetchVideosInPeriod.mockResolvedValue([{ name: "DJI_0001", created_time: "2026-09-03T10:00:00Z", link: "https://vimeo.com/123456789", duration: 60, description: null, pictures: { sizes: [] } }]);
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123456789", id: "123456789" }] }, byName: "Тарас", trigger: "webhook" });
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("DJI_0001");
  });
  it("statusBefore is null when there was no committed report", async () => {
    readReportJson.mockResolvedValue(null);
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: noHints, byName: "Тарас", trigger: "cli" });
    expect(r.statusBefore).toBeNull();
  });
  it("bails before any sync/recompute/refresh when there is no committed field-qa report", async () => {
    readReportJson.mockImplementation(async (feature: string) => (feature === "field-qa" ? null : { days: [row("NEEDS_REVIEW", 48)] }));
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(syncAllChannels).not.toHaveBeenCalled();
    expect(computeVerdicts).not.toHaveBeenCalled();
    expect(refreshPublishedDays).not.toHaveBeenCalled();
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("немає обробленого звіту");
    expect(r.statusBefore).toBe("NEEDS_REVIEW");
    expect(r.statusAfter).toBe("NEEDS_REVIEW");
  });
  it("matches a Vimeo id exactly, not as a substring of a longer id", async () => {
    computeVerdicts.mockResolvedValue({ days: [row("NEEDS_REVIEW", 48)] });
    fetchVideosInPeriod.mockResolvedValue([
      { name: "SHORT", created_time: "2026-09-01T10:00:00Z", link: "https://vimeo.com/123", duration: 60, description: null, pictures: { sizes: [] } },
      { name: "LONG", created_time: "2026-09-01T10:00:00Z", link: "https://vimeo.com/123456789", duration: 60, description: null, pictures: { sizes: [] } },
    ]);
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: "1.1", period, hints: { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123", id: "123" }] }, byName: "Тарас", trigger: "webhook" });
    expect(r.text).toContain("SHORT");
    expect(r.text).not.toContain("LONG");
  });
  it("multi-report day: an unmatched reportTs finds nothing; a null reportTs falls back to the day's first row", async () => {
    computeVerdicts.mockResolvedValue({
      days: [row("NEEDS_REVIEW", 48), { ...row("ACCEPTED", 96), reportTs: "2.2", reportSeq: 2, reportCount: 2 }],
    });
    const missing = await verifyEvidence({ date: "2026-09-01", reportTs: "9.9", period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(missing.statusAfter).toBeNull();
    expect(missing.text).toContain("не знайшов");

    const dayLevel = await verifyEvidence({ date: "2026-09-01", reportTs: null, period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(dayLevel.statusAfter).toBe("NEEDS_REVIEW");
  });
});
