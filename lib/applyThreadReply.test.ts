import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  postMessage: vi.fn(), classifyThreadReply: vi.fn(), createProposal: vi.fn(), readActiveProposals: vi.fn(),
  applyClassifiedInstruction: vi.fn(), recordEvidenceEvent: vi.fn(), settleProposal: vi.fn(),
}));
vi.mock("./slack", () => ({ postMessage: m.postMessage }));
vi.mock("./instructionClassify", () => ({ classifyThreadReply: m.classifyThreadReply }));
vi.mock("./proposals", () => ({ createProposal: m.createProposal, readActiveProposals: m.readActiveProposals, settleProposal: m.settleProposal }));
vi.mock("./applyInstructionReply", () => ({ applyClassifiedInstruction: m.applyClassifiedInstruction }));
vi.mock("./evidenceEvents", () => ({ recordEvidenceEvent: m.recordEvidenceEvent }));

import { applyThreadReply, targetEntry, type ReplyTarget } from "./applyThreadReply";

const period = { start: "2026-09-01", end: "2026-09-30" };
const verdict: ReplyTarget = {
  kind: "verdict", period,
  entry: { date: "2026-09-01", reportTs: "1.1", channel: "field-qa", text: "⚠️ 2026-09-01 (понеділок) — потрібна перевірка: відео 48 хв.\n👥 У полі: Тарас.", postedAt: "x", ts: "1781000000.000100" },
};
const ask: ReplyTarget = {
  kind: "ask", period,
  record: { gapType: "no_dataset", date: "2026-09-01", channel: "datasets", question: "За 2026-09-01 немає датасету…", state: "ASKED", askedTs: "1781000000.000900", askedAt: "x" },
};
const base = { replyText: "", userId: "U_PILOT", userName: "Тарас", role: "pilot" as const, replyTs: "1781000500.000100", replyPermalink: "https://s/p" };
const pendingPilot = { id: "p9", threadTs: verdict.entry.ts, channel: "field-qa", date: "2026-09-01", axis: "day", payload: {}, summaryUk: "прийняти день 2026-09-01 (виняток)", proposedBy: "Тарас", origin: "pilot", sourceReplyTs: "1781000400.000100", state: "PROPOSED", createdAt: "x", resolvedAt: null };

beforeEach(() => {
  m.postMessage.mockReset().mockResolvedValue("1781000600.000100");
  m.readActiveProposals.mockReset().mockResolvedValue([]);
  m.createProposal.mockReset().mockResolvedValue({ created: true, proposal: { ...pendingPilot } });
  m.applyClassifiedInstruction.mockReset().mockResolvedValue({ handled: "confirmed", applied: true, intent: "confirm" });
  m.recordEvidenceEvent.mockReset().mockResolvedValue({ created: true });
  m.settleProposal.mockReset().mockResolvedValue("CANCELLED");
  m.classifyThreadReply.mockReset();
});

describe("targetEntry", () => {
  it("builds a synthetic entry for an ask thread (ts = askedTs, channel = ask channel)", () => {
    expect(targetEntry(ask)).toMatchObject({ date: "2026-09-01", reportTs: null, channel: "datasets", ts: "1781000000.000900" });
  });
});

describe("applyThreadReply", () => {
  it("classifies with the role and the extracted hints", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "unclear", reason: "" });
    await applyThreadReply({ ...base, target: verdict, replyText: "https://vimeo.com/123456789" });
    const [, , , role, hints] = m.classifyThreadReply.mock.calls[0];
    expect(role).toBe("pilot");
    expect(hints.vimeoLinks[0].id).toBe("123456789");
  });
  it("pilot «так» with a pending proposal never settles anything and is silent", async () => {
    m.readActiveProposals.mockResolvedValue([pendingPilot]);
    m.classifyThreadReply.mockResolvedValue({ intent: "unclear", reason: "" }); // pilot schema has no confirm
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "так" });
    expect(r.handled).toBe("silent");
    expect(m.applyClassifiedInstruction).not.toHaveBeenCalled();
  });
  it("approver confirm delegates to applyClassifiedInstruction with the pending list", async () => {
    m.readActiveProposals.mockResolvedValue([pendingPilot]);
    m.classifyThreadReply.mockResolvedValue({ intent: "confirm", reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, userId: "U08G4HZQTTR", userName: "Bohdan Forostianyi", role: "approver", replyText: "так" });
    expect(r.handled).toBe("confirmed");
    expect(m.applyClassifiedInstruction).toHaveBeenCalledWith(expect.objectContaining({ approverName: "Bohdan Forostianyi", pending: [pendingPilot] }));
  });
  it("evidence → deferred verify work carrying hints + claim, no posts yet", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "evidence", evidence: [{ kind: "video", links: ["https://vimeo.com/1"] }], claim: { kind: "explanation", text: "дощ" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "залив https://vimeo.com/123456789, дощ" });
    expect(r.handled).toBe("deferred");
    if (r.handled === "deferred") {
      expect(r.work.kind).toBe("verify");
      expect(r.work.claim?.text).toBe("дощ");
    }
    expect(m.postMessage).not.toHaveBeenCalled();
  });
  it("claim → pilot-origin proposal + echo tagging both approvers, keyed by the reply ts", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ, запис не працював" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "дощ, запис не працював" });
    expect(r.handled).toBe("escalated");
    expect(m.createProposal).toHaveBeenCalledWith(expect.objectContaining({ origin: "pilot", proposedBy: "Тарас", axis: "day", sourceReplyTs: base.replyTs, threadTs: verdict.entry.ts }));
    const [channelId, text, meta, threadTs] = m.postMessage.mock.calls[0];
    expect(channelId).toBe("C08GY2NKF9D");
    expect(text).toContain("<@U08G4EC244X>");
    expect(text).toContain("Пропоную: прийняти день 2026-09-01 (виняток)");
    expect(meta.key).toBe(`instruction-ack:2026-09-01#1.1:escalate:${base.replyTs}`);
    expect(threadTs).toBe(verdict.entry.ts);
    expect(m.recordEvidenceEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "claim", outcome: "escalated", proposalId: "p9" }));
  });
  it("a failed audit write never fails the escalation — the echo still posts and the result is still escalated", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.recordEvidenceEvent.mockRejectedValue(new Error("db down"));
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ, запис не працював" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "дощ, запис не працював" });
    expect(r.handled).toBe("escalated");
    expect(m.postMessage).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  it("a failed escalation echo CANCELS the unseen proposal and rethrows (no hidden confirmable proposal)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.postMessage.mockRejectedValue(new Error("slack down"));
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ" }, reason: "" });
    await expect(applyThreadReply({ ...base, target: verdict, replyText: "дощ" })).rejects.toThrow("slack down");
    expect(m.settleProposal).toHaveBeenCalledWith(expect.objectContaining({ id: "p9" }), "cancel");
    expect(m.recordEvidenceEvent).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("claim in an ask thread maps by gap type and echoes into the ask thread", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "не було датасету" }, reason: "" });
    await applyThreadReply({ ...base, target: ask, replyText: "не було датасету" });
    expect(m.createProposal).toHaveBeenCalledWith(expect.objectContaining({ axis: "dataset", threadTs: "1781000000.000900", channel: "datasets" }));
    expect(m.postMessage.mock.calls[0][3]).toBe("1781000000.000900");
  });
  it("ask-thread approver instruction outside dataset-waive/video is redirected, not applied", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "instruction", axis: "dataset", datasetStatus: "DECLINED", reason: "ні" });
    const r = await applyThreadReply({ ...base, target: ask, userId: "U08G4HZQTTR", userName: "Bohdan Forostianyi", role: "approver", replyText: "не платимо" });
    expect(m.applyClassifiedInstruction).not.toHaveBeenCalled();
    expect(m.postMessage).toHaveBeenCalledTimes(1);
    const [channelId, text, meta, threadTs] = m.postMessage.mock.calls[0];
    expect(channelId).toBe("C08KG802THU");
    expect(threadTs).toBe("1781000000.000900");
    expect(meta.key).toBe(`instruction-ack:2026-09-01:ask-redirect:${base.replyTs}`);
    expect(text).toContain("треді вердикту");
    expect(r.handled).toBe("silent");
  });
  it("ask-thread approver dataset-waive instruction is allowed and delegated", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "instruction", axis: "dataset", datasetStatus: "WAIVED", reason: "ok" });
    await applyThreadReply({ ...base, target: ask, userId: "U08G4HZQTTR", userName: "Bohdan Forostianyi", role: "approver", replyText: "виняток" });
    expect(m.applyClassifiedInstruction).toHaveBeenCalledWith(expect.objectContaining({ entry: targetEntry(ask) }));
  });
  it("ask-thread approver day-axis instruction is redirected, not applied", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "instruction", axis: "day", decision: "accepted_exception", reason: "ok" });
    const r = await applyThreadReply({ ...base, target: ask, userId: "U08G4HZQTTR", userName: "Bohdan Forostianyi", role: "approver", replyText: "прийняти" });
    expect(m.applyClassifiedInstruction).not.toHaveBeenCalled();
    expect(r.handled).toBe("silent");
  });
  it("redelivered claim (createProposal created=false) posts nothing", async () => {
    m.createProposal.mockResolvedValue({ created: false, proposal: pendingPilot });
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "дощ" });
    expect(r.handled).toBe("silent");
    expect(m.postMessage).not.toHaveBeenCalled();
  });
  it("claim on an already-accepted verdict is silent", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "claim", claim: { kind: "explanation", text: "дощ" }, reason: "" });
    const r = await applyThreadReply({ ...base, target: { ...verdict, entry: { ...verdict.entry, text: "✅ 2026-09-01 — прийнято" } }, replyText: "дощ" });
    expect(r.handled).toBe("silent");
  });
  it("chat → deferred chat work", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "chat", reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "що ще бракує?" });
    expect(r).toMatchObject({ handled: "deferred", work: { kind: "chat" } });
  });
  it("unclear → silent, no event row (keeps the audit table for actions)", async () => {
    m.classifyThreadReply.mockResolvedValue({ intent: "unclear", reason: "" });
    const r = await applyThreadReply({ ...base, target: verdict, replyText: "ok" });
    expect(r.handled).toBe("silent");
    expect(m.recordEvidenceEvent).not.toHaveBeenCalled();
  });
});
