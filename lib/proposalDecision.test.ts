import { describe, expect, it } from "vitest";
import { nextState, supersedes } from "./proposalDecision";

describe("nextState", () => {
  it("PROPOSED + confirm → CONFIRMED", () => {
    expect(nextState("PROPOSED", "confirm")).toBe("CONFIRMED");
  });

  it("PROPOSED + cancel → CANCELLED", () => {
    expect(nextState("PROPOSED", "cancel")).toBe("CANCELLED");
  });

  it("PROPOSED + supersede → SUPERSEDED", () => {
    expect(nextState("PROPOSED", "supersede")).toBe("SUPERSEDED");
  });

  it("returns null from a terminal state (idempotent no-op on Slack redelivery)", () => {
    expect(nextState("CONFIRMED", "confirm")).toBeNull();
    expect(nextState("CANCELLED", "cancel")).toBeNull();
    expect(nextState("SUPERSEDED", "confirm")).toBeNull();
    expect(nextState("CONFIRMED", "supersede")).toBeNull();
  });
});

describe("supersedes", () => {
  it("a new instruction on the SAME axis replaces the pending one (approver corrected themselves)", () => {
    expect(supersedes("crew", "crew")).toBe(true);
  });
  it("a new instruction on a DIFFERENT axis leaves the pending one alone (day accept + crew fix stack up)", () => {
    // Regression: 2026-08-08 «прийняти день» was killed by the crew instruction that followed it,
    // so the approver's «так» applied only the crew and the accept was silently lost.
    expect(supersedes("crew", "day")).toBe(false);
    expect(supersedes("day", "crew")).toBe(false);
  });
});
