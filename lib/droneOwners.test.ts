import { describe, it, expect } from "vitest";
import { owesDroneSubmission } from "./droneOwners";

describe("owesDroneSubmission", () => {
  it("an owner without their own submission owes", () => {
    expect(owesDroneSubmission("Влад", [])).toBe(true);
    expect(owesDroneSubmission("Влад", ["U_SOMEONE_ELSE"])).toBe(true);
  });

  it("an owner who submitted does not owe", () => {
    expect(owesDroneSubmission("Влад", ["U091JDN2U5B"])).toBe(false);
  });

  it("a non-owner never owes", () => {
    expect(owesDroneSubmission("Тарас", [])).toBe(false);
  });

  it("an approver eligibility:counted correction outranks the gate (pay AND display)", () => {
    expect(owesDroneSubmission("Влад", [], { Влад: "counted" })).toBe(false);
    expect(owesDroneSubmission("Влад", [], { Влад: "not_counted" })).toBe(true);
    expect(owesDroneSubmission("Влад", [], { Тарас: "counted" })).toBe(true);
  });
});
