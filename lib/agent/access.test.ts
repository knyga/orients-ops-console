import { describe, it, expect } from "vitest";
import { isAllowedSlackUser, AGENT_REFUSAL_UK } from "./access";
import { APPROVERS } from "../approvers";
import { PEOPLE } from "../people";

describe("isAllowedSlackUser", () => {
  it("allows each approver", () => {
    for (const a of APPROVERS) expect(isAllowedSlackUser(a.userId)).toBe(true);
  });
  it("refuses a roster member who is not an approver", () => {
    const approverIds = new Set(APPROVERS.map((a) => a.userId));
    const nonApprover = PEOPLE.find((p) => p.slackId && !approverIds.has(p.slackId))!;
    expect(isAllowedSlackUser(nonApprover.slackId!)).toBe(false);
  });
  it("refuses an unknown id and empty input", () => {
    expect(isAllowedSlackUser("U_NOT_REAL")).toBe(false);
    expect(isAllowedSlackUser("")).toBe(false);
  });
});

describe("AGENT_REFUSAL_UK", () => {
  it("is a non-empty Ukrainian string", () => {
    expect(AGENT_REFUSAL_UK.length).toBeGreaterThan(0);
    expect(AGENT_REFUSAL_UK).toMatch(/[іїєґА-Яа-я]/);
  });
});
