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

  it("accepted_exception → RESOLVED + writeException, with that reply's evidence", () => {
    const o = decideOutcome([reply("still_missing"), reply("accepted_exception", "форс-мажор", "link2")]);
    expect(o).toEqual({ state: "RESOLVED", writeException: true, note: "форс-мажор", evidencePermalink: "link2" });
  });

  it("data_provided (no exception) → RESOLVED without writeException", () => {
    const o = decideOutcome([reply("unclear"), reply("data_provided", "drive link", "link3")]);
    expect(o?.state).toBe("RESOLVED");
    expect(o?.writeException).toBe(false);
  });

  it("only still_missing/unclear → ANSWERED using the last reply's note", () => {
    const o = decideOutcome([reply("unclear", "a"), reply("still_missing", "немає", "lastlink")]);
    expect(o).toEqual({ state: "ANSWERED", writeException: false, note: "немає", evidencePermalink: "lastlink" });
  });
});
