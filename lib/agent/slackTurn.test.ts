import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runAgent = vi.hoisted(() => vi.fn());
vi.mock("./loop", () => ({ runAgent }));
import { runSlackTurn } from "./slackTurn";
import { jiraTools } from "./tools/jira";

beforeEach(() => { process.env.ANTHROPIC_API_KEY = "k"; runAgent.mockReset(); });
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("runSlackTurn", () => {
  it("passes full tools + history and returns the AgentResult", async () => {
    runAgent.mockResolvedValue({ kind: "text", text: "answer" });
    const res = await runSlackTurn("q", [{ role: "user", text: "prev" }]);
    expect(res).toEqual({ kind: "text", text: "answer" });
    const opts = runAgent.mock.calls[0][1];
    expect(opts.history).toEqual([{ role: "user", text: "prev" }]);
    expect(opts.tools).toBe(jiraTools); // full set, not filtered to read
  });
  it("fails loud when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runSlackTurn("q", [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
