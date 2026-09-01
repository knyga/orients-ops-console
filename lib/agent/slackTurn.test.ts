import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runAgent = vi.hoisted(() => vi.fn());
vi.mock("./loop", () => ({ runAgent }));
import { runSlackTurn } from "./slackTurn";

beforeEach(() => { process.env.ANTHROPIC_API_KEY = "k"; runAgent.mockReset(); });
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("runSlackTurn", () => {
  it("passes history and returns the AgentResult, without pinning tools (loop default applies)", async () => {
    runAgent.mockResolvedValue({ kind: "text", text: "answer" });
    const res = await runSlackTurn("q", [{ role: "user", text: "prev" }]);
    expect(res).toEqual({ kind: "text", text: "answer" });
    const opts = runAgent.mock.calls[0][1];
    expect(opts.history).toEqual([{ role: "user", text: "prev" }]);
    expect(opts.tools).toBeUndefined(); // no override — loop's default FULL tool set applies
  });
  it("forwards sourceUrl so proposals can link back to the thread", async () => {
    runAgent.mockResolvedValue({ kind: "text", text: "a" });
    await runSlackTurn("q", [], { sourceUrl: "https://x.slack.com/archives/C1/p1" });
    expect(runAgent.mock.calls[0][1].sourceUrl).toBe("https://x.slack.com/archives/C1/p1");
  });

  it("fails loud when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runSlackTurn("q", [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  /**
   * 2026-09-01 (ATP-1891): the model answered plain TEXT imitating a proposal
   * echo («Продовжити? (так/ні)») without calling the write tool. One corrective
   * retry demands the tool call; the fake turn rides along as history so the
   * retry has full context.
   */
  describe("fake-confirm retry", () => {
    const FAKE = { kind: "text", text: "📝 Переведу ATP-1891 у статус Done.\nПродовжити? (так/ні)" };

    it("retries once with a corrective turn and returns the retry's proposal", async () => {
      const proposal = { kind: "proposal", text: "ECHO", proposal: { kind: "jira_transition", params: {}, echoUk: "ECHO", apply: vi.fn() } };
      runAgent.mockResolvedValueOnce(FAKE).mockResolvedValueOnce(proposal);
      const res = await runSlackTurn("перенеси ATP-1891 в done", [{ role: "user", text: "prev" }]);
      expect(res).toBe(proposal);
      expect(runAgent).toHaveBeenCalledTimes(2);
      const [correction, opts] = runAgent.mock.calls[1];
      expect(correction).toMatch(/СИСТЕМНЕ ЗАУВАЖЕННЯ/);
      // retry history = original history + the fake exchange
      expect(opts.history).toEqual([
        { role: "user", text: "prev" },
        { role: "user", text: "перенеси ATP-1891 в done" },
        { role: "assistant", text: FAKE.text },
      ]);
    });

    it("returns the retry's clean text answer", async () => {
      runAgent.mockResolvedValueOnce(FAKE).mockResolvedValueOnce({ kind: "text", text: "Задача вже в Done." });
      const res = await runSlackTurn("q", []);
      expect(res).toEqual({ kind: "text", text: "Задача вже в Done." });
    });

    it("keeps the original result when the retry fakes again (never loops)", async () => {
      runAgent.mockResolvedValueOnce(FAKE).mockResolvedValueOnce({ kind: "text", text: "Створити задачу? (так/ні)" });
      const res = await runSlackTurn("q", []);
      expect(res).toEqual(FAKE);
      expect(runAgent).toHaveBeenCalledTimes(2);
    });

    it("keeps the original result when the retry throws", async () => {
      runAgent.mockResolvedValueOnce(FAKE).mockRejectedValueOnce(new Error("api down"));
      const res = await runSlackTurn("q", []);
      expect(res).toEqual(FAKE);
    });

    it("does not retry a clean text answer or a real proposal", async () => {
      runAgent.mockResolvedValue({ kind: "text", text: "3 задачі закрито." });
      await runSlackTurn("q", []);
      expect(runAgent).toHaveBeenCalledTimes(1);
    });
  });
});
