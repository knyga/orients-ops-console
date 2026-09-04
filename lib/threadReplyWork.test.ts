import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ postMessage: vi.fn(), updateMessage: vi.fn(), verifyEvidence: vi.fn(), runVerdictChat: vi.fn(), recordEvidenceEvent: vi.fn(), escalateClaim: vi.fn() }));
vi.mock("./slack", () => ({ postMessage: m.postMessage, updateMessage: m.updateMessage }));
vi.mock("./evidenceVerify", () => ({ verifyEvidence: m.verifyEvidence }));
vi.mock("./agent/verdictChat", () => ({ runVerdictChat: m.runVerdictChat }));
vi.mock("./evidenceEvents", () => ({ recordEvidenceEvent: m.recordEvidenceEvent }));
vi.mock("./applyThreadReply", async (orig) => ({ ...(await (orig as () => Promise<Record<string, unknown>>)()), escalateClaim: m.escalateClaim }));

import { runDeferredWork, workPlaceholderKey } from "./threadReplyWork";
import type { DeferredWork } from "./applyThreadReply";

const period = { start: "2026-09-01", end: "2026-09-30" };
const work = (p: Partial<DeferredWork>): DeferredWork => ({
  kind: "verify", replyText: "залив", userId: "U1", userName: "Тарас", role: "pilot", replyTs: "1781000500.000100", replyPermalink: "p", trigger: "webhook",
  hints: { vimeoLinks: [], datasetPermalinks: [], timeRanges: [], minuteFigures: [] },
  target: { kind: "verdict", period, entry: { date: "2026-09-01", reportTs: "1.1", channel: "field-qa", text: "⚠️ …", postedAt: "x", ts: "1781000000.000100" } },
  ...p,
});

beforeEach(() => {
  m.postMessage.mockReset().mockResolvedValue("1781000700.000100");
  m.updateMessage.mockReset().mockResolvedValue("ph");
  m.verifyEvidence.mockReset().mockResolvedValue({ outcome: "closed", text: "✅ Перевірив…", verifyLine: "l", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED" });
  m.runVerdictChat.mockReset().mockResolvedValue("Бракує 12 хв");
  m.recordEvidenceEvent.mockReset().mockResolvedValue({ created: true });
  m.escalateClaim.mockReset().mockResolvedValue({ created: true, proposalId: "p1" });
});

describe("workPlaceholderKey", () => {
  it("is report-scoped and salted by the reply ts", () => {
    expect(workPlaceholderKey(work({}))).toBe("instruction-ack:2026-09-01#1.1:verify-ph:1781000500.000100");
  });
});

describe("runDeferredWork — verify", () => {
  it("edits the placeholder with the outcome text and records the event", async () => {
    await runDeferredWork(work({}), { placeholderTs: "ph" });
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "ph", "✅ Перевірив…", expect.objectContaining({ key: "instruction-ack:2026-09-01#1.1:verify:1781000500.000100" }));
    expect(m.recordEvidenceEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "evidence", outcome: "closed", statusBefore: "NEEDS_REVIEW", statusAfter: "ACCEPTED" }));
    expect(m.escalateClaim).not.toHaveBeenCalled();
  });
  it("posts into the thread when there is no placeholder (CLI path)", async () => {
    await runDeferredWork(work({}), {});
    expect(m.postMessage).toHaveBeenCalledWith("C08GY2NKF9D", "✅ Перевірив…", expect.anything(), "1781000000.000100");
  });
  it("still_open + claim → escalates with the verify line; closed + claim → no escalation", async () => {
    m.verifyEvidence.mockResolvedValue({ outcome: "still_open", text: "🔎 …", verifyLine: "відео 48 хв = 40%", statusBefore: "NEEDS_REVIEW", statusAfter: "NEEDS_REVIEW" });
    await runDeferredWork(work({ claim: { kind: "explanation", text: "дощ" } }), { placeholderTs: "ph" });
    expect(m.escalateClaim).toHaveBeenCalledWith(expect.objectContaining({ verifyLine: "відео 48 хв = 40%", claim: { kind: "explanation", text: "дощ" } }));
    expect(m.recordEvidenceEvent).not.toHaveBeenCalled(); // the escalation records the row
  });
  it("hard_fail + claim → escalates too (the approver may still accept as an exception)", async () => {
    m.verifyEvidence.mockResolvedValue({ outcome: "hard_fail", text: "⛔ …", verifyLine: "l", statusBefore: "REJECTED", statusAfter: "REJECTED" });
    await runDeferredWork(work({ claim: { kind: "explanation", text: "дощ" } }), { placeholderTs: "ph" });
    expect(m.escalateClaim).toHaveBeenCalled();
  });
});

describe("runDeferredWork — chat", () => {
  it("answers via runVerdictChat with the verdict text, excluding the reply + placeholder, chunked into the placeholder", async () => {
    await runDeferredWork(work({ kind: "chat", replyText: "що бракує?" }), { placeholderTs: "ph" });
    expect(m.runVerdictChat).toHaveBeenCalledWith(expect.objectContaining({ question: "що бракує?", verdictText: "⚠️ …", threadTs: "1781000000.000100", excludeTs: ["1781000500.000100", "ph"] }));
    expect(m.updateMessage).toHaveBeenCalledWith("C08GY2NKF9D", "ph", "Бракує 12 хв", expect.objectContaining({ key: "instruction-ack:2026-09-01#1.1:chat:1781000500.000100" }));
    expect(m.recordEvidenceEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "chat", outcome: "answered" }));
  });
});
