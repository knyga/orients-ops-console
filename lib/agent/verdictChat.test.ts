import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ runAgent: vi.fn(), fetchThreadContext: vi.fn() }));
vi.mock("./loop", () => ({ runAgent: m.runAgent }));
vi.mock("./threadContext", () => ({ fetchThreadContext: m.fetchThreadContext }));
import { runVerdictChat } from "./verdictChat";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "k";
  m.runAgent.mockReset().mockResolvedValue({ kind: "text", text: "**Бракує** 12 хв" });
  m.fetchThreadContext.mockReset().mockResolvedValue("Контекст треду (Slack):\n[Тарас]: залив");
});

describe("runVerdictChat", () => {
  it("runs the loop with READ tools only, no history, verdict + thread as context, and converts markdown", async () => {
    const out = await runVerdictChat({ question: "що бракує?", verdictText: "⚠️ …", channelId: "C1", threadTs: "1.1", excludeTs: ["1.2"] });
    const [text, opts] = m.runAgent.mock.calls[0];
    expect(text).toContain("⚠️ …");
    expect(text).toContain("[Тарас]: залив");
    expect(text).toContain("що бракує?");
    expect(opts.history).toBeUndefined();
    expect((opts.tools as { kind: string; name: string }[]).every((t) => t.kind === "read")).toBe(true);
    expect((opts.tools as { name: string }[]).map((t) => t.name)).toContain("field_verdict_status");
    expect(out).toBe("*Бракує* 12 хв");
  });
  it("degrades to the bare question when the thread fetch fails", async () => {
    m.fetchThreadContext.mockRejectedValue(new Error("boom"));
    await runVerdictChat({ question: "q", verdictText: "v", channelId: "C1", threadTs: "1.1", excludeTs: [] });
    expect(m.runAgent.mock.calls[0][0]).toContain("q");
  });
  it("coalesces an empty answer", async () => {
    m.runAgent.mockResolvedValue({ kind: "text", text: "" });
    expect(await runVerdictChat({ question: "q", verdictText: "v", channelId: "C1", threadTs: "1.1", excludeTs: [] })).toBe("Не маю відповіді на це.");
  });
});
