import { describe, it, expect } from "vitest";
import { decideThreadReply, publishedStatusHint } from "./threadReplyDecide";
import type { ThreadReplyClassification } from "./instructionClassifyPrompt";

const c = (p: Partial<ThreadReplyClassification>): ThreadReplyClassification => ({ intent: "unclear", reason: "", ...p });
const claim = { kind: "explanation" as const, text: "дощ" };
const video = [{ kind: "video" as const, links: ["https://vimeo.com/1"] }];

describe("publishedStatusHint", () => {
  it("reads the leading icon", () => {
    expect(publishedStatusHint("✅ 2026-09-01 — прийнято")).toBe("accepted");
    expect(publishedStatusHint("⚠️ 2026-09-01 — потрібна перевірка")).toBe("needs_review");
    expect(publishedStatusHint("⛔ 2026-09-01 — відхилено")).toBe("rejected");
    expect(publishedStatusHint("За 2026-09-01 на Vimeo…")).toBe("unknown");
  });
});

describe("decideThreadReply — priority", () => {
  it("approver confirm/cancel with pending wins", () => {
    expect(decideThreadReply(c({ intent: "confirm" }), "approver", true, "needs_review")).toEqual({ type: "confirm" });
    expect(decideThreadReply(c({ intent: "cancel" }), "approver", true, "needs_review")).toEqual({ type: "cancel" });
  });
  it("approver confirm with nothing pending is silent", () => {
    expect(decideThreadReply(c({ intent: "confirm" }), "approver", false, "needs_review").type).toBe("silent");
  });
  it("pilot confirm is always silent (never confirms)", () => {
    expect(decideThreadReply(c({ intent: "confirm" }), "pilot", true, "needs_review").type).toBe("silent");
  });
  it("approver instruction → instruction", () => {
    expect(decideThreadReply(c({ intent: "instruction", axis: "day", decision: "rejected" }), "approver", false, "needs_review")).toEqual({ type: "instruction" });
  });
  it("evidence → verify, carrying the claim", () => {
    expect(decideThreadReply(c({ intent: "evidence", evidence: video, claim }), "pilot", false, "needs_review")).toEqual({ type: "verify", evidence: video, claim });
  });
  it("evidence on a rejected day still verifies (the verifier reports hard_fail)", () => {
    expect(decideThreadReply(c({ intent: "evidence", evidence: video }), "pilot", false, "rejected").type).toBe("verify");
  });
  it("claim → escalate unless the day is already accepted", () => {
    expect(decideThreadReply(c({ intent: "claim", claim }), "pilot", false, "needs_review")).toEqual({ type: "escalate", claim });
    expect(decideThreadReply(c({ intent: "claim", claim }), "pilot", false, "accepted").type).toBe("silent");
  });
  it("a claim present escalates even when the model landed on chat or unclear", () => {
    expect(decideThreadReply(c({ intent: "chat", claim }), "pilot", false, "needs_review")).toEqual({ type: "escalate", claim });
    expect(decideThreadReply(c({ intent: "unclear", claim }), "pilot", false, "needs_review")).toEqual({ type: "escalate", claim });
  });
  it("a loss_found claim escalates even on an already-accepted day (only explanation/deploy_window are skipped)", () => {
    const lossFound = { kind: "loss_found" as const, text: "борт знайшли" };
    expect(decideThreadReply(c({ intent: "claim", claim: lossFound }), "pilot", false, "accepted")).toEqual({ type: "escalate", claim: lossFound });
  });
  it("chat → chat for both roles", () => {
    expect(decideThreadReply(c({ intent: "chat" }), "pilot", false, "needs_review")).toEqual({ type: "chat" });
    expect(decideThreadReply(c({ intent: "chat" }), "approver", true, "needs_review")).toEqual({ type: "chat" });
  });
  it("unclear → silent", () => {
    expect(decideThreadReply(c({ intent: "unclear" }), "pilot", false, "needs_review").type).toBe("silent");
  });
});
