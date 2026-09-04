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

import { verifyEvidence, findVerdictRow } from "./evidenceVerify";
import type { DayVerdict } from "./fieldDayVerdict";

const period = { start: "2026-09-01", end: "2026-09-30" };
const noHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };
const row = (status: DayVerdict["status"], videoMinutes: number): DayVerdict => ({
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
  it("a failing Vimeo diagnostics lookup never turns a completed recompute into a failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchVideosInPeriod.mockRejectedValue(new Error("vimeo 502"));
    const r = await verifyEvidence({
      date: "2026-09-01", reportTs: "1.1", period,
      hints: { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123456789", id: "123456789" }] },
      byName: "Тарас", trigger: "webhook",
    });
    expect(r.outcome).toBe("closed"); // the recompute already flipped the day
    expect(r.statusAfter).toBe("ACCEPTED");
    expect(r.text).not.toContain("Можлива причина");
    spy.mockRestore();
  });
  it("a failing Vimeo diagnostics lookup on a still-open day never claims the hinted video is missing (unknown, not not-found)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    computeVerdicts.mockResolvedValue({ days: [row("NEEDS_REVIEW", 48)] });
    fetchVideosInPeriod.mockRejectedValue(new Error("vimeo 502"));
    const r = await verifyEvidence({
      date: "2026-09-01", reportTs: "1.1", period,
      hints: { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/123456789", id: "123456789" }] },
      byName: "Тарас", trigger: "webhook",
    });
    expect(r.outcome).toBe("still_open");
    expect(r.text).not.toContain("не знайдено");
    spy.mockRestore();
  });
  it("a failing #datasets permalink lookup is soft-failed the same way", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    readChannelMessages.mockRejectedValue(new Error("mirror down"));
    const r = await verifyEvidence({
      date: "2026-09-01", reportTs: "1.1", period,
      hints: { ...noHints, datasetPermalinks: [{ url: "https://slack/p", ts: "9.9" }] },
      byName: "Тарас", trigger: "webhook",
    });
    expect(r.outcome).toBe("closed");
    spy.mockRestore();
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
  it("day-level target on a multi-report day answers about the report that is still OPEN, not the accepted one", async () => {
    computeVerdicts.mockResolvedValue({
      days: [row("ACCEPTED", 96), { ...row("NEEDS_REVIEW", 48), reportTs: "2.2", reportSeq: 2, reportCount: 2 }],
    });
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: null, period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(r.statusAfter).toBe("NEEDS_REVIEW");
    expect(r.outcome).toBe("still_open");
  });
  it("day-level target with EVERY report accepted closes on the first row", async () => {
    computeVerdicts.mockResolvedValue({
      days: [row("ACCEPTED", 96), { ...row("ACCEPTED_EXCEPTION", 10), reportTs: "2.2", reportSeq: 2, reportCount: 2 }],
    });
    const r = await verifyEvidence({ date: "2026-09-01", reportTs: null, period, hints: noHints, byName: "Тарас", trigger: "webhook" });
    expect(r.statusAfter).toBe("ACCEPTED");
    expect(r.outcome).toBe("closed");
  });
});

describe("findVerdictRow", () => {
  const accepted = { ...row("ACCEPTED", 96), reportTs: "1.1" };
  const open = { ...row("NEEDS_REVIEW", 48), reportTs: "2.2", reportSeq: 2, reportCount: 2 };

  it("a named reportTs matches exactly and never borrows another report of the day", () => {
    expect(findVerdictRow([accepted, open], "2026-09-01", "2.2")).toBe(open);
    expect(findVerdictRow([accepted, open], "2026-09-01", "9.9")).toBeNull();
  });
  it("a day-level target (reportTs null) picks the first NOT-yet-accepted report", () => {
    expect(findVerdictRow([accepted, open], "2026-09-01", null)).toBe(open);
    expect(findVerdictRow([{ ...accepted, status: "ACCEPTED_EXCEPTION" }, open], "2026-09-01", null)).toBe(open);
  });
  it("all reports accepted → the first row", () => {
    const both: DayVerdict[] = [accepted, { ...open, status: "ACCEPTED_EXCEPTION" }];
    expect(findVerdictRow(both, "2026-09-01", null)).toBe(accepted);
  });
  it("no row for the date → null", () => {
    expect(findVerdictRow([accepted], "2026-09-02", null)).toBeNull();
    expect(findVerdictRow(undefined, "2026-09-01", null)).toBeNull();
  });
});
