import { describe, it, expect } from "vitest";
import { anchorDateFromText, droneReminderAnchorLine, planDroneReminder } from "./droneReminderPlan";
import { DRONE_OWNERS } from "./droneOwners";

describe("droneReminderAnchorLine / anchorDateFromText", () => {
  it("round-trips: the anchor line parses back to its date", () => {
    const line = droneReminderAnchorLine("2026-08-03");
    expect(line).toBe("🛸 Звіт по дронах за 03.08");
    expect(anchorDateFromText(line, "2026-08-03")).toBe("2026-08-03");
  });

  it("parses the anchor out of the FULL reminder message (first line)", () => {
    const plan = planDroneReminder({ date: "2026-08-03", submittedUserIds: [] });
    expect(plan).not.toBeNull();
    expect(anchorDateFromText(plan!.text, "2026-08-03")).toBe("2026-08-03");
  });

  it("returns null for non-anchor text", () => {
    expect(anchorDateFromText("Звіт 08:00–19:00 Влад, Тарас", "2026-08-03")).toBeNull();
    expect(anchorDateFromText("шось про 🛸 Звіт по дронах за колись", "2026-08-03")).toBeNull();
  });

  it("takes the year from the post date", () => {
    expect(anchorDateFromText("🛸 Звіт по дронах за 31.12", "2027-12-31")).toBe("2027-12-31");
  });

  it("rejects a malformed date input", () => {
    expect(() => droneReminderAnchorLine("03.08.2026")).toThrow();
  });
});

describe("planDroneReminder", () => {
  it("tags only the owners who have not submitted", () => {
    const plan = planDroneReminder({ date: "2026-08-03", submittedUserIds: ["U091JDN2U5B"] });
    expect(plan).not.toBeNull();
    expect(plan!.missing.map((o) => o.rosterName)).toEqual(["Любомир", "Андріан"]);
    expect(plan!.text).not.toContain("<@U091JDN2U5B>");
    expect(plan!.text).toContain("<@U091JDPH9L5>");
    expect(plan!.text).toContain("<@U09AAVAEE6L>");
    expect(plan!.text).toContain("у треді цього повідомлення");
  });

  it("returns null when every owner submitted (post nothing)", () => {
    expect(
      planDroneReminder({ date: "2026-08-03", submittedUserIds: DRONE_OWNERS.map((o) => o.userId) }),
    ).toBeNull();
  });

  it("non-owner submitters do not satisfy anyone's gate", () => {
    const plan = planDroneReminder({ date: "2026-08-03", submittedUserIds: ["U_SOMEONE"] });
    expect(plan!.missing).toHaveLength(3);
  });
});
