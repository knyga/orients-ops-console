import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock("./loop", () => ({ runAgent: runAgentMock }));

import { askAgent } from "./slackAgent";
import { jiraTools } from "./tools/jira";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  runAgentMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("askAgent", () => {
  it("passes ONLY read tools to runAgent and returns its text", async () => {
    runAgentMock.mockResolvedValue({ kind: "text", text: "ATP-7 [Done] Fix" });
    const out = await askAgent("what was done today");
    expect(out).toBe("ATP-7 [Done] Fix");
    const opts = runAgentMock.mock.calls[0][1] as { tools: { kind: string }[] };
    expect(opts.tools.length).toBeGreaterThan(0);
    expect(opts.tools.every((t) => t.kind === "read")).toBe(true);
    // sanity: there IS at least one write tool in the full set that we excluded
    expect(jiraTools.some((t) => t.kind === "write")).toBe(true);
  });

  it("returns the loop's text for an error result too (already Ukrainian)", async () => {
    runAgentMock.mockResolvedValue({ kind: "error", text: "Вибач, не встиг." });
    expect(await askAgent("x")).toBe("Вибач, не встиг.");
  });

  it("coalesces an empty answer to a Ukrainian fallback (never posts empty text)", async () => {
    runAgentMock.mockResolvedValue({ kind: "text", text: "   " });
    expect(await askAgent("x")).toBe("Не маю відповіді на це.");
  });

  it("throws loudly when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(askAgent("x")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
