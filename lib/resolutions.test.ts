import { describe, expect, it } from "vitest";
import { applyResolution, deriveDatasetStatus, type Resolution } from "./resolutions";
import type { DayVerdict } from "./fieldDayVerdict";

const res = (over: Partial<Resolution>): Resolution => ({
  date: "2026-06-13",
  axis: "day",
  decision: "accepted_exception",
  note: "force majeure — confirmed by Bogdan",
  source: "manual",
  recordedAt: "2026-06-19T00:00:00.000Z",
  ...over,
});

const needsReview: DayVerdict = {
  date: "2026-06-13",
  status: "NEEDS_REVIEW",
  airborneMinutes: 20,
  videoMinutes: 2,
  ratio: 0.1,
  datasetStatus: "MISSING",
  withinGrace: false,
  reasons: ["video < 50%"],
};

describe("resolutionFor / applyResolution (legacy day-axis tests)", () => {
  it("flips NEEDS_REVIEW → ACCEPTED_EXCEPTION when a day-axis resolution exists for the day", () => {
    const out = applyResolution(needsReview, [res({})]);
    expect(out.status).toBe("ACCEPTED_EXCEPTION");
    expect(out.reasons.join(" ")).toMatch(/force majeure/);
  });

  it("leaves a verdict untouched when no resolution matches the date", () => {
    const out = applyResolution(needsReview, [res({ date: "2026-06-01" })]);
    expect(out.status).toBe("NEEDS_REVIEW");
  });

  it("does not let accepted_exception override a non-NEEDS_REVIEW verdict", () => {
    const accepted = { ...needsReview, status: "ACCEPTED" as const };
    expect(applyResolution(accepted, [res({})]).status).toBe("ACCEPTED");
  });

  it("folds the approver name into the exception reason", () => {
    const out = applyResolution(needsReview, [res({ by: "Oleksandr K" })]);
    expect(out.reasons.join(" ")).toMatch(/exception \(Oleksandr K\)/);
  });

  it("a rejected resolution vetoes from ANY status → REJECTED", () => {
    expect(applyResolution(needsReview, [res({ decision: "rejected", note: "redo it", by: "Bohdan Forostianyi" })]).status).toBe("REJECTED");
    const accepted = { ...needsReview, status: "ACCEPTED" as const };
    const out = applyResolution(accepted, [res({ decision: "rejected", note: "not acceptable" })]);
    expect(out.status).toBe("REJECTED");
    expect(out.reasons.join(" ")).toMatch(/rejected.*not acceptable/);
  });

});

// ── New tests for Task 2 ──────────────────────────────────────────────────────

const R = (over: Partial<Resolution>): Resolution => ({
  date: "2026-06-10",
  axis: "dataset",
  decision: "accepted_exception",
  note: "fog, no flight worth a dataset",
  source: "slack",
  recordedAt: "2026-06-12T00:00:00.000Z",
  ...over,
});

describe("deriveDatasetStatus", () => {
  it("posted notice → POSTED", () => {
    expect(deriveDatasetStatus(true, "2026-06-10", []).status).toBe("POSTED");
  });
  it("no notice, dataset-axis exception → WAIVED with the verbatim note", () => {
    const d = deriveDatasetStatus(false, "2026-06-10", [R({})]);
    expect(d.status).toBe("WAIVED");
    expect(d.note).toContain("fog");
  });
  it("no notice, dataset-axis rejection → DECLINED", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", [R({ decision: "rejected" })]).status).toBe("DECLINED");
  });
  it("no notice, nothing recorded → MISSING", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", []).status).toBe("MISSING");
  });
  it("a video-axis exception does NOT waive the dataset", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", [R({ axis: "video" })]).status).toBe("MISSING");
  });
  it("a day-axis exception waives the dataset (whole-day forgiveness)", () => {
    expect(deriveDatasetStatus(false, "2026-06-10", [R({ axis: "day" })]).status).toBe("WAIVED");
  });
  it("posted but day-axis rejected → still POSTED here (day veto handled by applyResolution)", () => {
    expect(deriveDatasetStatus(true, "2026-06-10", [R({ axis: "day", decision: "rejected" })]).status).toBe("POSTED");
  });
});

describe("applyResolution (video/day axes only)", () => {
  const verdict: DayVerdict = {
    date: "2026-06-10", status: "NEEDS_REVIEW" as const, airborneMinutes: 100,
    videoMinutes: 10, ratio: 0.1, datasetStatus: "WAIVED" as const, withinGrace: false, reasons: [],
  };
  it("video-axis exception flips NEEDS_REVIEW → ACCEPTED_EXCEPTION", () => {
    const out = applyResolution(verdict, [R({ axis: "video" })]);
    expect(out.status).toBe("ACCEPTED_EXCEPTION");
  });
  it("day-axis rejection vetoes to REJECTED", () => {
    const out = applyResolution(verdict, [R({ axis: "day", decision: "rejected" })]);
    expect(out.status).toBe("REJECTED");
  });
  it("a dataset-axis resolution is ignored here (it drives the dataset status, not the overlay)", () => {
    const out = applyResolution({ ...verdict, status: "ACCEPTED" }, [R({ axis: "dataset" })]);
    expect(out.status).toBe("ACCEPTED");
  });
});
