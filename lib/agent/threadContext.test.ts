import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ fetchThreadMessages: vi.fn() }));
vi.mock("@/lib/slack", () => ({ fetchThreadMessages: h.fetchThreadMessages }));

import { formatThreadContext, parseThreadRef, fetchThreadContext } from "./threadContext";

// U08G4EC244X is Oleksandr K in the real lib/people.ts registry.
const KNOWN = "U08G4EC244X";

describe("formatThreadContext", () => {
  it("renders oldest-first with roster names, raw <@U…> for unknowns, [бот] for bots", () => {
    const out = formatThreadContext([
      { ts: "1.0", user: KNOWN, text: "перше" },
      { ts: "2.0", user: "U_UNKNOWN", text: "друге" },
      { ts: "3.0", botId: "B1", text: "від бота" },
    ]);
    expect(out).toBe(
      "Контекст треду (Slack):\n[Oleksandr K]: перше\n[<@U_UNKNOWN>]: друге\n[бот]: від бота",
    );
  });

  it("excludes excludeTs messages (the incoming mention + placeholder)", () => {
    const out = formatThreadContext(
      [
        { ts: "1.0", user: KNOWN, text: "context" },
        { ts: "9.0", user: "U2", text: "@bot створи тікет" },
        { ts: "9.1", botId: "B1", text: "🤔 думаю…" },
      ],
      { excludeTs: ["9.0", "9.1"] },
    );
    expect(out).toBe("Контекст треду (Slack):\n[Oleksandr K]: context");
  });

  it("returns null when nothing remains", () => {
    expect(formatThreadContext([], {})).toBeNull();
    expect(
      formatThreadContext([{ ts: "9.0", user: "U2", text: "hi" }], { excludeTs: ["9.0"] }),
    ).toBeNull();
  });

  it("keeps only the newest maxMessages and notes the drop", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      ts: `${i}.0`,
      user: "U2",
      text: `msg${i}`,
    }));
    const out = formatThreadContext(msgs, { maxMessages: 2 });
    expect(out).toBe(
      "Контекст треду (Slack):\n(3 старіших повідомлень пропущено)\n[<@U2>]: msg3\n[<@U2>]: msg4",
    );
  });

  it("drops oldest lines until under maxChars", () => {
    const msgs = [
      { ts: "1.0", user: "U2", text: "a".repeat(100) },
      { ts: "2.0", user: "U2", text: "b".repeat(100) },
      { ts: "3.0", user: "U2", text: "tail" },
    ];
    const out = formatThreadContext(msgs, { maxChars: 150 })!;
    expect(out).toContain("tail");
    expect(out).not.toContain("a".repeat(100));
    expect(out).toContain("пропущено");
  });
});

describe("parseThreadRef", () => {
  it("parses channelId:ts", () => {
    expect(parseThreadRef("C09M551C9UK:1783244631.100559")).toEqual({
      channelId: "C09M551C9UK",
      threadTs: "1783244631.100559",
    });
  });

  it("parses a Slack permalink", () => {
    expect(
      parseThreadRef("https://orientsai.slack.com/archives/C09M551C9UK/p1783244631100559"),
    ).toEqual({ channelId: "C09M551C9UK", threadTs: "1783244631.100559" });
  });

  it("prefers the thread_ts query param on a reply permalink", () => {
    expect(
      parseThreadRef(
        "https://orientsai.slack.com/archives/C09M551C9UK/p1783250000123456?thread_ts=1783244631.100559&cid=C09M551C9UK",
      ),
    ).toEqual({ channelId: "C09M551C9UK", threadTs: "1783244631.100559" });
  });

  it("returns null on garbage", () => {
    expect(parseThreadRef("not-a-ref")).toBeNull();
    expect(parseThreadRef("https://example.com/foo")).toBeNull();
  });
});

describe("fetchThreadContext", () => {
  it("fetches and formats, passing excludeTs through", async () => {
    h.fetchThreadMessages.mockResolvedValue([
      { ts: "1.0", user: KNOWN, text: "context" },
      { ts: "9.0", user: "U2", text: "mention" },
    ]);
    const out = await fetchThreadContext("C1", "1.0", ["9.0"]);
    expect(h.fetchThreadMessages).toHaveBeenCalledWith("C1", "1.0");
    expect(out).toBe("Контекст треду (Slack):\n[Oleksandr K]: context");
  });
});
