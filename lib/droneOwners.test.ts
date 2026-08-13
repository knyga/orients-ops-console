import { describe, it, expect } from "vitest";
import { DRONE_GATE_EFFECTIVE_DATE, owesDroneSubmission } from "./droneOwners";

describe("owesDroneSubmission", () => {
  const D = "2026-08-03"; // any date on/after the rule's effective date

  it("an owner without their own submission owes", () => {
    expect(owesDroneSubmission("Влад", [], D)).toBe(true);
    expect(owesDroneSubmission("Влад", ["U_SOMEONE_ELSE"], D)).toBe(true);
  });

  it("an owner who submitted does not owe", () => {
    expect(owesDroneSubmission("Влад", ["U091JDN2U5B"], D)).toBe(false);
  });

  it("a non-owner never owes", () => {
    expect(owesDroneSubmission("Тарас", [], D)).toBe(false);
  });

  it("an approver eligibility:counted correction outranks the gate (pay AND display)", () => {
    expect(owesDroneSubmission("Влад", [], D, { Влад: "counted" })).toBe(false);
    expect(owesDroneSubmission("Влад", [], D, { Влад: "not_counted" })).toBe(true);
    expect(owesDroneSubmission("Влад", [], D, { Тарас: "counted" })).toBe(true);
  });

  it("nobody owes for a date before the rule took effect", () => {
    expect(owesDroneSubmission("Влад", [], "2026-07-27")).toBe(false);
    expect(owesDroneSubmission("Влад", ["U09AAVAEE6L"], "2026-07-13")).toBe(false);
  });

  it("an owner owes from the rule's effective date onward", () => {
    expect(owesDroneSubmission("Влад", [], DRONE_GATE_EFFECTIVE_DATE)).toBe(true);
    expect(owesDroneSubmission("Влад", [], "2026-07-30")).toBe(true);
  });
});
