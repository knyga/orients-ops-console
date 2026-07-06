import { describe, expect, it } from "vitest";
import { planLossAlerts } from "./lossNotice";

describe("planLossAlerts", () => {
  it("no change → no messages, state preserved", () => {
    const p = planLossAlerts(2, { lastAlertedCount: 2, fieldqaWarnedAt3: false }, "2026-07");
    expect(p.operatorDm).toBeNull();
    expect(p.fieldQaWarning).toBeNull();
    expect(p.next).toEqual({ lastAlertedCount: 2, fieldqaWarnedAt3: false });
  });
  it("first sighting (no state) with losses → operator DM", () => {
    const p = planLossAlerts(2, null, "2026-07");
    expect(p.operatorDm).toContain("2");
    expect(p.operatorDm).toContain("2026-07");
    expect(p.fieldQaWarning).toBeNull();
  });
  it("2→3 → DM + one-time #field-qa warning in Ukrainian", () => {
    const p = planLossAlerts(3, { lastAlertedCount: 2, fieldqaWarnedAt3: false }, "2026-07");
    expect(p.operatorDm).toContain("3 (було 2)");
    expect(p.fieldQaWarning).toContain("втрат");
    expect(p.fieldQaWarning).toContain("обнул");
    expect(p.next).toEqual({ lastAlertedCount: 3, fieldqaWarnedAt3: true });
  });
  it("recovery 3→2 → DM, and a later re-3 does NOT re-warn the channel", () => {
    const down = planLossAlerts(2, { lastAlertedCount: 3, fieldqaWarnedAt3: true }, "2026-07");
    expect(down.operatorDm).toContain("2 (було 3)");
    expect(down.fieldQaWarning).toBeNull();
    const up = planLossAlerts(3, down.next, "2026-07");
    expect(up.fieldQaWarning).toBeNull();
  });
  it("4th loss → DM says the month is wiped", () => {
    const p = planLossAlerts(4, { lastAlertedCount: 3, fieldqaWarnedAt3: true }, "2026-07");
    expect(p.operatorDm).toContain("обнулено");
  });
  it("zero losses and no prior state → nothing", () => {
    const p = planLossAlerts(0, null, "2026-07");
    expect(p.operatorDm).toBeNull();
    expect(p.fieldQaWarning).toBeNull();
  });
});
