import { describe, expect, it } from "vitest";
import { gapKey, gapsForDay } from "./askGaps";
import type { DayVerdict } from "./fieldDayVerdict";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-13",
  status: "NEEDS_REVIEW",
  airborneMinutes: 20,
  videoMinutes: 66,
  ratio: 3.3,
  datasetStatus: "MISSING",
  withinGrace: false,
  reasons: [],
  ...over,
});

describe("gapsForDay", () => {
  it("returns no gaps for non-NEEDS_REVIEW days", () => {
    expect(gapsForDay(day({ status: "ACCEPTED" }))).toEqual([]);
    expect(gapsForDay(day({ status: "PENDING" }))).toEqual([]);
    expect(gapsForDay(day({ status: "ACCEPTED_EXCEPTION" }))).toEqual([]);
  });

  it("emits a no_dataset gap (to #datasets) when video is fine but dataset missing", () => {
    const gaps = gapsForDay(day({ ratio: 3.3, datasetStatus: "MISSING" }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapType).toBe("no_dataset");
    expect(gaps[0].channel).toBe("datasets");
    // Question carries the Ukrainian weekday; the structured `date` stays raw.
    expect(gaps[0].question).toContain("2026-06-13 (субота)");
    expect(gaps[0].date).toBe("2026-06-13");
  });

  it("emits a low_video gap (to #field-qa) when video < 50%", () => {
    const gaps = gapsForDay(day({ ratio: 0.1, videoMinutes: 2, datasetStatus: "POSTED" }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].gapType).toBe("low_video");
    expect(gaps[0].channel).toBe("field-qa");
  });

  it("emits a low_video gap when ratio is null (zero airborne edge)", () => {
    const gaps = gapsForDay(day({ ratio: null, videoMinutes: 0, datasetStatus: "POSTED" }));
    expect(gaps.map((g) => g.gapType)).toEqual(["low_video"]);
  });

  it("emits BOTH gaps when video < 50% and no dataset", () => {
    const gaps = gapsForDay(day({ ratio: 0.0, videoMinutes: 0, datasetStatus: "MISSING" }));
    expect(gaps.map((g) => g.gapType)).toEqual(["low_video", "no_dataset"]);
  });

  it("exact-50% video is OK → no low_video gap", () => {
    const gaps = gapsForDay(day({ ratio: 0.5, datasetStatus: "POSTED" }));
    expect(gaps).toEqual([]);
  });

  it("does not ask about a waived dataset", () => {
    const gaps = gapsForDay(day({ ratio: 3.3, datasetStatus: "WAIVED" }));
    expect(gaps.some((g) => g.gapType === "no_dataset")).toBe(false);
  });

  it("gapKey is stable per (type, date)", () => {
    expect(gapKey("no_dataset", "2026-06-13")).toBe("no_dataset:2026-06-13");
  });
});
