import { describe, expect, it } from "vitest";
import {
  fieldSummaryKey,
  approvalAckKey,
  approvalEditKey,
  approvalOutboundKeys,
  askKey,
  backfillEditKey,
  bonusDmKey,
  bonusThreadKey,
  contentRev,
  decideReserve,
  dmHelpKey,
  detectOrigin,
  investorKey,
  linksEditKey,
  linksTargetKey,
  linksZvitEditKey,
  linksZvitKey,
  rosterAckKey,
  rosterEditKey,
  sprintAnchorKey,
  sprintPlanFilledKey,
  sprintPlanPendingKey,
  verdictKey,
  webhookFailureKey,
} from "./outboundKeys";

describe("key builders", () => {
  it("build stable, namespaced keys", () => {
    expect(verdictKey("2026-06", "2026-06-01")).toBe("verdict:2026-06:2026-06-01");
    expect(askKey("no_dataset", "2026-06-08")).toBe("ask:no_dataset:2026-06-08");
    expect(approvalEditKey("2026-06-04", "abc")).toBe("approval-edit:2026-06-04:abc");
    expect(approvalAckKey("2026-06-04", "abc")).toBe("approval-ack:2026-06-04:abc");
    expect(webhookFailureKey("2026-06-04", "approver", "abc")).toBe(
      "webhook-failure:2026-06-04:approver:abc",
    );
    expect(bonusThreadKey("2026-06-04")).toBe("bonus-thread:2026-06-04");
    expect(bonusDmKey("2026-06-04", "U123")).toBe("bonus-dm:2026-06-04:U123");
    expect(backfillEditKey("2026-06-01", "abc")).toBe("backfill-edit:2026-06-01:abc");
    expect(dmHelpKey("U123", "1782899951.295969")).toBe("help:U123:1782899951.295969");
  });
});

describe("approvalOutboundKeys", () => {
  it("derives edit+ack keys from (date, decision), independent of reason wording", () => {
    // The deciding factor is the decision — NOT the reason text, which Claude
    // re-generates (differently) on each webhook redelivery. Same decision must
    // dedup to one send; a flip to the other decision must repost.
    expect(approvalOutboundKeys("2026-06-21", "accepted_exception")).toEqual({
      editKey: "approval-edit:2026-06-21:accepted_exception",
      ackKey: "approval-ack:2026-06-21:accepted_exception",
    });
    expect(approvalOutboundKeys("2026-06-21", "rejected")).toEqual({
      editKey: "approval-edit:2026-06-21:rejected",
      ackKey: "approval-ack:2026-06-21:rejected",
    });
    // A flip changes both keys (so it reposts).
    expect(approvalOutboundKeys("2026-06-21", "accepted_exception").ackKey).not.toBe(
      approvalOutboundKeys("2026-06-21", "rejected").ackKey,
    );
  });

  it("a salt (the instructing reply's ts) separates a flip BACK to an earlier decision", () => {
    // accept → reject → accept: the third apply must not collide with the first
    // (2026-09-04: the re-accept was silently skipped as "already sent").
    const first = approvalOutboundKeys("2026-08-30#1.0", "accepted_exception", "1788444106.792309");
    const again = approvalOutboundKeys("2026-08-30#1.0", "accepted_exception", "1788510237.178909");
    expect(first).toEqual({
      editKey: "approval-edit:2026-08-30#1.0:accepted_exception:1788444106.792309",
      ackKey: "approval-ack:2026-08-30#1.0:accepted_exception:1788444106.792309",
    });
    expect(again.editKey).not.toBe(first.editKey);
    expect(again.ackKey).not.toBe(first.ackKey);
    // Same salt (a redelivery) still dedups.
    expect(approvalOutboundKeys("2026-08-30#1.0", "accepted_exception", "1788510237.178909")).toEqual(again);
    // No salt keeps the legacy shape.
    expect(approvalOutboundKeys("2026-08-30#1.0", "accepted_exception").editKey).toBe(
      "approval-edit:2026-08-30#1.0:accepted_exception",
    );
  });
});

describe("contentRev", () => {
  it("is deterministic and differs by content", () => {
    expect(contentRev("hello")).toBe(contentRev("hello"));
    expect(contentRev("hello")).not.toBe(contentRev("world"));
    expect(contentRev("hello")).toMatch(/^[0-9a-z]+$/);
  });
});

describe("detectOrigin", () => {
  it("maps VERCEL=1 to vercel, else local", () => {
    expect(detectOrigin({ VERCEL: "1" })).toBe("vercel");
    expect(detectOrigin({})).toBe("local");
  });
});

describe("decideReserve", () => {
  it("wins when our insert succeeded", () => {
    expect(decideReserve({ ts: "1.2" }, null)).toEqual({ won: true, existingTs: "1.2" });
  });
  it("retries a previously failed row", () => {
    expect(decideReserve(null, { status: "failed", ts: null })).toEqual({
      won: true,
      existingTs: null,
    });
  });
  it("loses to an existing sent/pending row and returns its ts", () => {
    expect(decideReserve(null, { status: "sent", ts: "9.9" })).toEqual({
      won: false,
      existingTs: "9.9",
    });
    expect(decideReserve(null, { status: "pending", ts: null })).toEqual({
      won: false,
      existingTs: null,
    });
  });
  it("loses to a stuck pending EDIT row with NO ts — the edit never landed", () => {
    // An edit's reservation row carries the target ts up-front; surfacing it
    // would let a skipped edit masquerade as a message carrying the content.
    expect(decideReserve(null, { status: "pending", ts: "5.5" })).toEqual({
      won: false,
      existingTs: null,
    });
  });
  it("loses to an existing skipped row and returns its ts", () => {
    expect(decideReserve(null, { status: "skipped", ts: "7.7" })).toEqual({
      won: false,
      existingTs: "7.7",
    });
  });
  it("reclaims a failed row that already has a ts and returns that ts", () => {
    expect(decideReserve(null, { status: "failed", ts: "3.3" })).toEqual({
      won: true,
      existingTs: "3.3",
    });
  });
});

describe("roster outbound keys", () => {
  it("namespaces edit + ack by date and rev", () => {
    expect(rosterEditKey("2026-06-10", "abc")).toBe("roster-edit:2026-06-10:abc");
    expect(rosterAckKey("2026-06-10", "abc")).toBe("roster-ack:2026-06-10:abc");
  });
});

describe("investorKey", () => {
  it("namespaces the send by the explicit week key", () => {
    expect(investorKey("2026-07-20_2026-07-26")).toBe("investor:2026-07-20_2026-07-26");
  });
});

describe("sprint-plan fallback keys", () => {
  it("keys the pending anchor by channel + the run's Kyiv day", () => {
    expect(sprintPlanPendingKey("2026-08-25", "general")).toBe(
      "sprint-plan-pending:general:2026-08-25",
    );
  });
  it("keys the fill-in edit by channel + sprint slug, slug last (the guard parses it)", () => {
    expect(sprintPlanFilledKey("ATP-49", "general")).toBe("sprint-plan-filled:general:ATP-49");
    expect(sprintPlanFilledKey("ATP-49", "general").split(":").pop()).toBe("ATP-49");
  });
  it("is channel-scoped: a test-channel send never suppresses the #general one", () => {
    expect(sprintPlanPendingKey("2026-08-25", "general")).not.toBe(
      sprintPlanPendingKey("2026-08-25", "bot-test"),
    );
    expect(sprintPlanFilledKey("ATP-49", "general")).not.toBe(
      sprintPlanFilledKey("ATP-49", "bot-test"),
    );
  });
  it("never collides with the committed anchor's post reservation", () => {
    // The fill-in EDIT must not be skipped by a reservation held under the
    // committed post's key (same reasoning as backfillEditKey).
    const filled = sprintPlanFilledKey("ATP-49", "general");
    const anchor = sprintAnchorKey("committed", "ATP-49", "general");
    expect(filled).not.toBe(anchor);
    expect(filled.startsWith("sprint-committed")).toBe(false);
    expect(anchor.startsWith("sprint-plan")).toBe(false);
  });
});

describe("fieldSummaryKey", () => {
  it("scopes by period, Kyiv day, channel, optional thread and part", () => {
    expect(fieldSummaryKey("2026-08", "2026-09-03", "field-qa", null, "anchor")).toBe("field-summary:2026-08:2026-09-03:field-qa:anchor");
    expect(fieldSummaryKey("2026-08", "2026-09-03", "field-qa", "1788300000.000001", "t2")).toBe(
      "field-summary:2026-08:2026-09-03:field-qa:1788300000.000001:t2",
    );
  });
  it("differs across channels for the same day (a test-channel publish must not dedup #field-qa)", () => {
    expect(fieldSummaryKey("2026-08", "2026-09-03", "orients-ops-console-test", null, "anchor")).not.toBe(
      fieldSummaryKey("2026-08", "2026-09-03", "field-qa", null, "anchor"),
    );
  });
});

describe("links keys", () => {
  it("target keys are report-exact for per-Звіт targets and date-only for the reminder", () => {
    expect(linksTargetKey({ kind: "reminder", date: "2026-09-03" })).toBe("reminder:2026-09-03");
    expect(linksTargetKey({ kind: "verdict", date: "2026-09-03", reportTs: "1.5" })).toBe("verdict:2026-09-03#1.5");
    expect(linksTargetKey({ kind: "bonus", date: "2026-09-03", reportTs: "1.5" })).toBe("bonus:2026-09-03#1.5");
    expect(linksTargetKey({ kind: "zvit", reportTs: "1.5" })).toBe("zvit:1.5");
  });
  it("edit / post keys are namespaced apart from every other key family", () => {
    expect(linksEditKey({ kind: "reminder", date: "2026-09-03" }, "abc")).toBe("links-edit:reminder:2026-09-03:abc");
    expect(linksZvitKey("1.5")).toBe("links-zvit:1.5");
    expect(linksZvitEditKey("1.5", "abc")).toBe("links-zvit-edit:1.5:abc");
  });
});
