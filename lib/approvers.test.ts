import { describe, expect, it } from "vitest";
import { approverFor, APPROVERS, isApprover } from "./approvers";

describe("approvers", () => {
  it("recognizes the two authorized approvers", () => {
    expect(isApprover("U08G4EC244X")).toBe(true); // Oleksandr K
    expect(isApprover("U08G4HZQTTR")).toBe(true); // Bohdan Forostianyi
    expect(approverFor("U08G4EC244X")?.role).toBe("CEO/CTO");
  });

  it("rejects anyone else (incl. the similarly-named Олександр Сорока)", () => {
    expect(isApprover("U08G4HURRCP")).toBe(false);
    expect(isApprover("U_RANDOM")).toBe(false);
    expect(approverFor("nope")).toBeUndefined();
  });

  it("each approver has a userId, name, and role", () => {
    for (const a of APPROVERS) {
      expect(a.userId).toMatch(/^U/);
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.role.length).toBeGreaterThan(0);
    }
  });
});
