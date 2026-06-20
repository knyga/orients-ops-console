import { describe, expect, it } from "vitest";
import { decideApproval, parseArgs, resolvePeriod, type ApproverReply } from "./fieldApprovalsReport";

const reply = (decision: ApproverReply["classification"]["decision"], ts: string, by = "Oleksandr K", reason = "r"): ApproverReply => ({
  classification: { decision, reason },
  by,
  permalink: `p${ts}`,
  ts,
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

describe("decideApproval", () => {
  it("no decisive replies → null", () => {
    expect(decideApproval([])).toBeNull();
    expect(decideApproval([reply("unclear", "1.0")])).toBeNull();
  });

  it("a single approve → approve outcome with evidence + approver", () => {
    const o = decideApproval([reply("approve", "1.0", "Bohdan Forostianyi", "тестували інше")]);
    expect(o).toEqual({ decision: "approve", reason: "тестували інше", by: "Bohdan Forostianyi", evidencePermalink: "p1.0" });
  });

  it("most-recent decisive reply wins (approver changed their mind)", () => {
    const o = decideApproval([reply("approve", "1.0"), reply("unclear", "2.0"), reply("disapprove", "3.0")]);
    expect(o?.decision).toBe("disapprove");
    expect(o?.evidencePermalink).toBe("p3.0");
  });

  it("orders by ts regardless of input order", () => {
    const o = decideApproval([reply("disapprove", "3.0"), reply("approve", "1.0")]);
    expect(o?.decision).toBe("disapprove"); // 3.0 is latest
  });
});
