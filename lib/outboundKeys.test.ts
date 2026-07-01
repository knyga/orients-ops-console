import { describe, expect, it } from "vitest";
import {
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
  rosterAckKey,
  rosterEditKey,
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
