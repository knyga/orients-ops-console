import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyResolution,
  readResolutions,
  resolutionFor,
  upsertResolution,
  writeResolutions,
  type Resolution,
} from "./resolutions";
import type { DayVerdict } from "./fieldDayVerdict";

const res = (over: Partial<Resolution>): Resolution => ({
  date: "2026-06-13",
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
  datasetPosted: false,
  withinGrace: false,
  reasons: ["video < 50%"],
};

describe("resolutionFor / applyResolution", () => {
  it("flips NEEDS_REVIEW → ACCEPTED_EXCEPTION when a resolution exists for the day", () => {
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

  it("resolutionFor returns the matching resolution or undefined", () => {
    expect(resolutionFor("2026-06-13", [res({})])?.note).toMatch(/force majeure/);
    expect(resolutionFor("2026-06-14", [res({})])).toBeUndefined();
  });
});

describe("store I/O", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "resolutions-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("round-trips; missing store → []", () => {
    expect(readResolutions({ baseDir })).toEqual([]);
    writeResolutions([res({})], { baseDir });
    expect(readResolutions({ baseDir })).toEqual([res({})]);
  });

  it("upsertResolution replaces by date, keeps others", () => {
    writeResolutions([res({ date: "2026-06-01" })], { baseDir });
    upsertResolution(res({ date: "2026-06-13" }), { baseDir });
    upsertResolution(res({ date: "2026-06-13", note: "updated" }), { baseDir });
    const all = readResolutions({ baseDir });
    expect(all).toHaveLength(2);
    expect(resolutionFor("2026-06-13", all)?.note).toBe("updated");
  });
});
