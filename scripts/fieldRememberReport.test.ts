import { describe, expect, it } from "vitest";
import { decideOutcome, parseArgs, resolvePeriod, type ClassifiedReply } from "./fieldRememberReport";

const reply = (type: ClassifiedReply["classification"]["type"], note = "n", permalink = "p"): ClassifiedReply => ({
  classification: { resolved: type === "accepted_exception" || type === "data_provided", type, note },
  permalink,
});

describe("parseArgs / resolvePeriod", () => {
  it("dry-run default; --write flips", () => {
    expect(parseArgs([]).write).toBe(false);
    expect(parseArgs(["--write"]).write).toBe(true);
  });
  it("defaults to current month", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-20")).toEqual({ start: "2026-06-01", end: "2026-06-20" });
  });
});

describe("decideOutcome", () => {
  it("no replies → null (leave ask untouched)", () => {
    expect(decideOutcome([])).toBeNull();
  });

  it("an accepted_exception explanation ESCALATES instead of writing an exception", () => {
    const o = decideOutcome([{ classification: { resolved: true, type: "accepted_exception", note: "дощ" }, permalink: "p" }]);
    expect(o).toMatchObject({ state: "ESCALATED", escalate: true, claimText: "дощ" });
  });

  it("data_provided → ANSWERED (the nightly recompute verifies), no escalation", () => {
    const o = decideOutcome([{ classification: { resolved: true, type: "data_provided", note: "залив" }, permalink: "p" }]);
    expect(o).toMatchObject({ state: "ANSWERED", escalate: false });
  });

  it("only still_missing/unclear → ANSWERED using the last reply's note", () => {
    const o = decideOutcome([reply("unclear", "a"), reply("still_missing", "немає", "lastlink")]);
    expect(o).toEqual({ state: "ANSWERED", escalate: false, note: "немає", evidencePermalink: "lastlink" });
  });
});
