import { describe, it, expect, vi } from "vitest";
import { runAgent } from "./loop";
import type { Tool } from "./tools/types";

// A fake Anthropic client scripted with a queue of responses.
function fakeClient(responses: { stop_reason: string | null; content: unknown[] }[]) {
  const create = vi.fn();
  responses.forEach((r) => create.mockResolvedValueOnce(r));
  return { messages: { create } };
}

const readTool: Tool = {
  name: "demo_read",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  kind: "read",
  run: async () => ({ ok: true, content: "RESULT-42" }),
};
const writeTool: Tool = {
  name: "demo_write",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  kind: "write",
  propose: async () => ({ kind: "demo_write", params: {}, echoUk: "ЕХО", apply: async () => "APPLIED" }),
};

describe("runAgent", () => {
  it("returns text when the model answers directly", async () => {
    const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Привіт" }] }]);
    const res = await runAgent("hi", { client, tools: [readTool] });
    expect(res).toEqual({ kind: "text", text: "Привіт" });
  });

  it("executes a read tool then returns the follow-up text", async () => {
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "demo_read", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Готово: RESULT-42" }] },
    ]);
    const res = await runAgent("do it", { client, tools: [readTool] });
    expect(res.kind).toBe("text");
    expect(res.text).toContain("RESULT-42");
    // second call must include a tool_result for t1
    const secondBody = client.messages.create.mock.calls[1][0] as { messages: { role: string; content: unknown }[] };
    const asString = JSON.stringify(secondBody.messages);
    expect(asString).toContain("tool_result");
    expect(asString).toContain("RESULT-42");
  });

  it("returns a proposal (does NOT apply) on a write tool_use", async () => {
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "w1", name: "demo_write", input: {} }] },
    ]);
    const res = await runAgent("create", { client, tools: [writeTool] });
    expect(res.kind).toBe("proposal");
    expect(res.text).toBe("ЕХО");
    expect(res.proposal?.kind).toBe("demo_write");
    // exactly one model call — the loop stops at the write
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("hands opts.sourceUrl to propose() as context", async () => {
    const propose = vi.fn(async () => ({
      kind: "demo_write",
      params: {},
      echoUk: "ЕХО",
      apply: async () => "APPLIED",
    }));
    const tool: Tool = { ...writeTool, propose };
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "w1", name: "demo_write", input: { a: 1 } }] },
    ]);
    await runAgent("create", { client, tools: [tool], sourceUrl: "https://x.slack.com/archives/C1/p1" });
    expect(propose).toHaveBeenCalledWith({ a: 1 }, { sourceUrl: "https://x.slack.com/archives/C1/p1" });
  });

  it("feeds a propose error back to the model instead of throwing", async () => {
    const failingWrite: Tool = {
      ...writeTool,
      propose: async () => {
        throw new Error("Unknown person: Тарас Панасюк");
      },
    };
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "w1", name: "demo_write", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Не знаю такої людини — уточни імʼя." }] },
    ]);
    const res = await runAgent("create", { client, tools: [failingWrite] });
    expect(res.kind).toBe("text");
    expect(res.text).toContain("уточни");
    // second call must carry the propose error as a tool_result for w1
    const secondBody = client.messages.create.mock.calls[1][0] as { messages: { role: string; content: unknown }[] };
    const asString = JSON.stringify(secondBody.messages);
    expect(asString).toContain("tool_result");
    expect(asString).toContain("Unknown person");
  });

  it("stops with an error text after exceeding maxIters", async () => {
    const toolUse = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "demo_read", input: {} }] };
    const client = fakeClient([toolUse, toolUse, toolUse]);
    const res = await runAgent("loop", { client, tools: [readTool], maxIters: 2 });
    expect(res.kind).toBe("error");
    expect(res.text).toContain("не встиг");
  });

  it("stops with an error text when wall-clock budget is exceeded", async () => {
    // Counter-based now: first call returns 0, subsequent calls return 60_000 to exceed BUDGET_MS (50_000).
    let callCount = 0;
    const clockNow = () => (callCount++ === 0 ? 0 : 60_000);
    // Provide a tool_use response so the loop tries to iterate (otherwise it would return text on first response).
    const client = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "demo_read", input: {} }] },
    ]);
    const res = await runAgent("test", { client, tools: [readTool], now: clockNow });
    expect(res.kind).toBe("error");
    expect(res.text).toContain("не встиг");
  });

  it("tells the model today's Kyiv date in the system prompt", async () => {
    const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
    // 2026-07-05T23:30Z is already 2026-07-06 in Kyiv (UTC+3) — the date must be Kyiv's, not UTC's.
    await runAgent("яка дата?", { client, tools: [readTool], now: () => Date.UTC(2026, 6, 5, 23, 30) });
    const body = client.messages.create.mock.calls[0][0] as { system: string };
    expect(body.system).toContain("2026-07-06");
  });

  it("seeds prior history before the new user message", async () => {
    const client = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }]);
    await runAgent("new question", {
      client,
      tools: [readTool],
      history: [
        { role: "user", text: "earlier q" },
        { role: "assistant", text: "earlier a" },
      ],
    });
    const body = client.messages.create.mock.calls[0][0] as { messages: { role: string; content: unknown }[] };
    expect(body.messages).toEqual([
      { role: "user", content: "earlier q" },
      { role: "assistant", content: "earlier a" },
      { role: "user", content: "new question" },
    ]);
  });
});
