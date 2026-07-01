import { describe, expect, it } from "vitest";
import { nextState } from "./proposalDecision";

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
