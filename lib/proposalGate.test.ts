import { describe, expect, it } from "vitest";
import { canDriveProposal, gateProposalApply } from "./proposalGate";

describe("canDriveProposal", () => {
  it("lets the requester drive their own proposal", () => {
    expect(canDriveProposal("U_REQ", "U_REQ")).toBe(true);
  });
  it("lets an approver drive someone else's proposal", () => {
    expect(canDriveProposal("U_REQ", "U08G4EC244X")).toBe(true);
    expect(canDriveProposal("U_REQ", "U08G4HZQTTR")).toBe(true);
  });
  it("refuses a non-requester non-approver", () => {
    expect(canDriveProposal("U_REQ", "U_OTHER")).toBe(false);
  });
});

describe("gateProposalApply", () => {
  it("passes non-gated kinds for anyone", () => {
    expect(gateProposalApply("jira_create", "U_RANDOM")).toEqual({ ok: true, extraParams: {} });
  });
  it("passes field_loss_set for an approver and injects their name", () => {
    const r = gateProposalApply("field_loss_set", "U08G4EC244X");
    expect(r).toEqual({ ok: true, extraParams: { by: "Oleksandr K" } });
  });
  it("refuses field_loss_set for a non-approver, in Ukrainian", () => {
    const r = gateProposalApply("field_loss_set", "U_RANDOM");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusalUk).toContain("затверджувач");
  });
});

describe("gateProposalApply — sprint_plan_build", () => {
  it("passes for an approver and injects their name", () => {
    const r = gateProposalApply("sprint_plan_build", "U08G4HZQTTR");
    expect(r).toEqual({ ok: true, extraParams: { by: "Bohdan Forostianyi" } });
  });
  it("refuses a non-approver with the sprint-specific Ukrainian refusal", () => {
    const r = gateProposalApply("sprint_plan_build", "U_RANDOM");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusalUk).toContain("план спринту");
      expect(r.refusalUk).toContain("затверджувач");
    }
  });
});
