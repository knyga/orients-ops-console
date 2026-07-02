import { describe, it, expect } from "vitest";
import { isAllowedSlackUser, AGENT_REFUSAL_UK } from "./access";
import { PEOPLE } from "../people";

describe("isAllowedSlackUser", () => {
  it("allows a known roster Slack id", () => {
    const known = PEOPLE.find((p) => p.slackId)!.slackId!;
    expect(isAllowedSlackUser(known)).toBe(true);
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
