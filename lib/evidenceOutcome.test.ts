import { describe, it, expect } from "vitest";
import { evidenceOutcome } from "./evidenceOutcome";
import type { DayVerdict } from "./fieldDayVerdict";
import type { ReplyHints } from "./threadReplyHints";

const noHints: ReplyHints = { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] };
const day = (p: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-09-01", reportTs: "1.1", reportSeq: 1, reportCount: 1, status: "NEEDS_REVIEW",
  airborneMinutes: 120, videoMinutes: 48, ratio: 0.4, datasetStatus: "POSTED", withinGrace: false,
  reasons: [], roster: ["Тарас"], unknownInitials: [], airborneReported: true, deployMin: 300, ...p,
});

describe("evidenceOutcome", () => {
  it("ACCEPTED → closed with the fresh numbers and thanks", () => {
    const r = evidenceOutcome({ day: day({ status: "ACCEPTED", videoMinutes: 96, ratio: 0.8 }), byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("closed");
    expect(r.text).toContain("✅ Перевірив");
    expect(r.text).toContain("96 хв");
    expect(r.text).toContain("80%");
    expect(r.text).toContain("Тарас");
  });
  it("NEEDS_REVIEW → still_open with the shortfall in minutes", () => {
    const r = evidenceOutcome({ day: day({}), byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("48 хв");
    expect(r.text).toContain("40%");
    expect(r.text).toContain("бракує 12 хв");
  });
  it("names a linked video whose name carries no date for this day", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/1", id: "1" }] };
    const r = evidenceOutcome({
      day: day({}), byName: "Тарас", hints,
      linkedVideos: [{ id: "1", name: "DJI_0001", created_time: "2026-09-03T10:00:00Z", link: "https://vimeo.com/1" }],
      datasetLinkDates: new Map(),
    });
    expect(r.text).toContain("DJI_0001");
    expect(r.text).toContain("без дати в назві");
    expect(r.text).toContain("01.09");
  });
  it("names a linked video dated another day", () => {
    const hints: ReplyHints = { ...noHints, vimeoLinks: [{ url: "https://vimeo.com/2", id: "2" }] };
    const r = evidenceOutcome({
      day: day({}), byName: "Тарас", hints,
      linkedVideos: [{ id: "2", name: "2026-08-30 політ", created_time: "2026-09-03T10:00:00Z", link: "https://vimeo.com/2" }],
      datasetLinkDates: new Map(),
    });
    expect(r.text).toContain("датоване 30.08");
  });
  it("names a #datasets link dated another day", () => {
    const hints: ReplyHints = { ...noHints, datasetPermalinks: [{ url: "u", ts: "1.5" }] };
    const r = evidenceOutcome({ day: day({ datasetStatus: "MISSING" }), byName: "Тарас", hints, linkedVideos: [], datasetLinkDates: new Map([["1.5", "2026-08-30"]]) });
    expect(r.text).toContain("#datasets");
    expect(r.text).toContain("іншим днем");
  });
  it("REJECTED → hard_fail pointing at the claim path", () => {
    const r = evidenceOutcome({ day: day({ status: "REJECTED", deployMin: 150 }), byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("hard_fail");
    expect(r.text).toContain("⛔");
    expect(r.text).toContain("пояснення");
  });
  it("missing day after recompute → still_open with a plain notice", () => {
    const r = evidenceOutcome({ day: null, byName: "Тарас", hints: noHints, linkedVideos: [], datasetLinkDates: new Map() });
    expect(r.outcome).toBe("still_open");
    expect(r.text).toContain("не знайшов");
  });
});
