import { describe, expect, it } from "vitest";
import { verdictForDay } from "./fieldDayVerdict";

const base = {
  flightDate: "2026-06-16",
  airborneMinutes: 20,
  videoMinutes: 12, // ratio 0.6 ≥ 0.5
  datasetStatus: "POSTED" as const,
  today: "2026-06-30", // well after grace
  graceWorkingDays: 3,
};

describe("verdictForDay", () => {
  it("ACCEPTED when ratio ≥ 0.5 and a dataset notice exists", () => {
    const v = verdictForDay(base);
    expect(v.status).toBe("ACCEPTED");
    expect(v.ratio).toBeCloseTo(0.6);
    expect(v.datasetStatus).toBe("POSTED");
  });

  it("PENDING when still within grace and a condition is unmet", () => {
    const v = verdictForDay({ ...base, datasetStatus: "MISSING", today: "2026-06-17" });
    expect(v.status).toBe("PENDING");
    expect(v.withinGrace).toBe(true);
  });

  it("NEEDS_REVIEW when grace elapsed and video < 50%", () => {
    const v = verdictForDay({ ...base, videoMinutes: 5, today: "2026-06-30" }); // ratio 0.25
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.reasons.join(" ")).toMatch(/50%|video/i);
  });

  it("NEEDS_REVIEW when grace elapsed and no dataset notice", () => {
    const v = verdictForDay({ ...base, datasetStatus: "MISSING" });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.reasons.join(" ")).toMatch(/dataset/i);
  });

  it("exact 50% passes the gate (>=)", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 20, videoMinutes: 10 });
    expect(v.status).toBe("ACCEPTED");
  });

  it("ratio is null when airborne is 0 and the day NEEDS_REVIEW after grace", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 0, videoMinutes: 0 });
    expect(v.ratio).toBeNull();
    expect(v.status).toBe("NEEDS_REVIEW");
  });

  it("grace boundary: today == flightDate + 3 wd is still within grace", () => {
    // 2026-06-16 (Tue) + 3 wd = 2026-06-19 (Fri)
    const v = verdictForDay({ ...base, datasetStatus: "MISSING", today: "2026-06-19" });
    expect(v.withinGrace).toBe(true);
    expect(v.status).toBe("PENDING");
  });
});

describe("verdictForDay with DatasetStatus", () => {
  const base = {
    flightDate: "2026-06-10",
    airborneMinutes: 100,
    videoMinutes: 60, // 60% ≥ 50% → videoOk
    today: "2026-06-30", // well after grace
    graceWorkingDays: 3,
  };

  it("WAIVED + video OK → ACCEPTED (a stated reason validates the dataset axis)", () => {
    const v = verdictForDay({ ...base, datasetStatus: "WAIVED" });
    expect(v.status).toBe("ACCEPTED");
    expect(v.datasetStatus).toBe("WAIVED");
  });

  it("DECLINED → REJECTED regardless of video", () => {
    const v = verdictForDay({ ...base, datasetStatus: "DECLINED" });
    expect(v.status).toBe("REJECTED");
    expect(v.reasons.some((r) => /declined/i.test(r))).toBe(true);
  });

  it("MISSING after grace → NEEDS_REVIEW", () => {
    const v = verdictForDay({ ...base, datasetStatus: "MISSING" });
    expect(v.status).toBe("NEEDS_REVIEW");
  });

  it("MISSING within grace → PENDING", () => {
    const v = verdictForDay({ ...base, datasetStatus: "MISSING", today: "2026-06-10" });
    expect(v.status).toBe("PENDING");
  });

  it("WAIVED but video short, after grace → NEEDS_REVIEW (dataset OK, video axis fails)", () => {
    const v = verdictForDay({ ...base, datasetStatus: "WAIVED", videoMinutes: 10 });
    expect(v.status).toBe("NEEDS_REVIEW");
  });
});
