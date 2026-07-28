import { describe, it, expect } from "vitest";
import {
  dateFromDroneReminderKey,
  droneReminderAnchorLine,
  droneReminderAnchors,
  droneReminderKey,
  planDroneReminder,
} from "./droneReminderPlan";
import { DRONE_OWNERS } from "./droneOwners";

describe("droneReminderKey / dateFromDroneReminderKey", () => {
  it("round-trips", () => {
    expect(droneReminderKey("2026-08-03")).toBe("drone-reminder:2026-08-03");
    expect(dateFromDroneReminderKey("drone-reminder:2026-08-03")).toBe("2026-08-03");
  });

  it("rejects foreign or malformed keys and dates", () => {
    expect(dateFromDroneReminderKey("verdict:2026-08-03")).toBeNull();
    expect(dateFromDroneReminderKey("drone-reminder:03.08")).toBeNull();
    expect(() => droneReminderKey("03.08.2026")).toThrow();
  });
});

describe("droneReminderAnchors", () => {
  it("maps only SENT drone-reminder rows with a ts", () => {
    const anchors = droneReminderAnchors([
      { feature: "drone-reminder", status: "sent", ts: "1000.1", key: "drone-reminder:2026-08-03" },
      { feature: "drone-reminder", status: "failed", ts: "1000.2", key: "drone-reminder:2026-08-04" },
      { feature: "drone-reminder", status: "sent", ts: null, key: "drone-reminder:2026-08-05" },
      { feature: "verdict", status: "sent", ts: "1000.3", key: "verdict:2026-08-03" },
    ]);
    expect(anchors).toEqual(new Map([["1000.1", "2026-08-03"]]));
  });
});

describe("droneReminderAnchorLine", () => {
  it("renders the human first line", () => {
    expect(droneReminderAnchorLine("2026-08-03")).toBe("🛸 Звіт по дронах за 03.08");
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
