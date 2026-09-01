import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runSlackTurn: vi.fn(),
  loadTranscript: vi.fn(),
  appendTurn: vi.fn(),
  insertPending: vi.fn(),
  updateMessage: vi.fn(),
  fetchThreadContext: vi.fn(),
}));

vi.mock("@/lib/agent/slackTurn", () => ({ runSlackTurn: h.runSlackTurn }));
vi.mock("@/lib/agentThread", () => ({
  loadTranscript: h.loadTranscript,
  appendTurn: h.appendTurn,
}));
vi.mock("@/lib/agentProposals", () => ({ insertPending: h.insertPending }));
vi.mock("@/lib/slack", () => ({
  updateMessage: h.updateMessage,
  permalinkFor: (c: string, ts: string) => `https://orientsai.slack.com/archives/${c}/p${ts.replace(".", "")}`,
}));
vi.mock("@/lib/agent/threadContext", () => ({ fetchThreadContext: h.fetchThreadContext }));

import { POST } from "./route";

const SECRET = "s3cret";
beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.loadTranscript.mockResolvedValue([]);
  h.fetchThreadContext.mockResolvedValue(null);
  process.env.AGENT_RUN_SECRET = SECRET;
});

function req(body: unknown, secret = SECRET) {
  return new Request("https://x/api/agent/run", {
    method: "POST",
    headers: {
      "x-agent-secret": secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const base = {
  surface: "dm",
  conversationKey: "C1",
  channelId: "C1",
  userId: "U1",
  incomingTs: "1",
  placeholderTs: "2",
  question: "q",
};

describe("POST /api/agent/run", () => {
  it("401 on bad secret", async () => {
    const res = await POST(req(base, "wrong"));
    expect(res.status).toBe(401);
    expect(h.updateMessage).not.toHaveBeenCalled();
  });

  it("DM text → edits placeholder + appends turn", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "answer", expect.anything());
    expect(h.appendTurn).toHaveBeenCalledWith("C1", "q", "answer");
  });

  it("DM proposal → edits with echo + persists PENDING", async () => {
    h.runSlackTurn.mockResolvedValue({
      kind: "proposal",
      text: "ECHO",
      proposal: {
        kind: "jira_create",
        params: { a: 1 },
        echoUk: "ECHO",
        apply: vi.fn(),
      },
    });
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "ECHO", expect.anything());
    expect(h.insertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C1",
        kind: "jira_create",
        params: { a: 1 },
        summaryUk: "ECHO",
        proposedBy: "U1",
      }),
    );
  });

  it("missing key → fails loud in the placeholder", async () => {
    h.runSlackTurn.mockRejectedValue(
      new Error("ANTHROPIC_API_KEY is not set on the server."),
    );
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    expect(String(h.updateMessage.mock.calls[0][2])).toMatch(/ключ|помилка|ANTHROPIC/i);
  });

  it("mention proposal is keyed by conversationKey (thread_ts), posts in the real channel", async () => {
    h.runSlackTurn.mockResolvedValue({
      kind: "proposal",
      text: "echo",
      proposal: {
        kind: "jira_create",
        params: { a: 1 },
        echoUk: "echo",
        apply: vi.fn(),
      },
    });
    const mentionReq = {
      surface: "mention",
      conversationKey: "111.222",
      channelId: "C-issue-log",
      userId: "U1",
      incomingTs: "111.900",
      placeholderTs: "111.901",
      threadTs: "111.222",
      question: "створи задачу для Тараса",
    };
    const res = await POST(req(mentionReq));
    expect(res.status).toBe(200);
    expect(h.insertPending).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "111.222", proposedBy: "U1", kind: "jira_create" }),
    );
    expect(h.loadTranscript).toHaveBeenCalledWith("111.222");
    expect(h.appendTurn).toHaveBeenCalledWith("111.222", "створи задачу для Тараса", "echo");
    expect(h.updateMessage).toHaveBeenCalledWith("C-issue-log", "111.901", "echo", expect.anything());
  });

  /**
   * 2026-09-01 (ATP-1891): the model produced a TEXT answer imitating a
   * proposal echo («Продовжити? (так/ні)») — nothing pending, so the user's
   * «так» went nowhere. The prompt already forbids this; prompts are not
   * enforcement. The surface appends a deterministic warning so a fake
   * confirmation ask can never pass as a real one — and memory stores a
   * neutral marker INSTEAD of the fake, because a fake stored verbatim in
   * agent_threads teaches the model to fake again on every later turn in the
   * same thread (the self-poisoning loop that kept ATP-1891 stuck).
   */
  it("text answer imitating a confirmation ask gets the no-proposal warning appended", async () => {
    h.runSlackTurn.mockResolvedValue({
      kind: "text",
      text: "📝 Переведу ATP-1891 у статус Done.\nПродовжити? (так/ні)",
    });
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    const sent = h.updateMessage.mock.calls[0][2] as string;
    expect(sent).toContain("⚠️");
    expect(sent).toContain("не пропозиція");
    expect(h.insertPending).not.toHaveBeenCalled();
    // memory gets the marker, never the fake text (breaks the imitation loop)
    const remembered = h.appendTurn.mock.calls[0][2] as string;
    expect(remembered).not.toContain("Продовжити?");
    expect(remembered).toContain("імітацією підтвердження");
  });

  it("a plain text answer gets no warning", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "Задача ATP-1891 вже в Done." });
    await POST(req(base));
    const sent = h.updateMessage.mock.calls[0][2] as string;
    expect(sent).not.toContain("⚠️");
  });

  it("DM text is converted from markdown to Slack mrkdwn before posting", async () => {
    h.runSlackTurn.mockResolvedValue({
      kind: "text",
      text: "- **ATP-1685** — [Done] Натренувати",
    });
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    const posted = "• *ATP-1685* — [Done] Натренувати";
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", posted, expect.anything());
    expect(h.appendTurn).toHaveBeenCalledWith("C1", "q", posted);
  });

  it("DM text empty result → defaults to fallback message", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "   " });
    const res = await POST(req(base));
    expect(res.status).toBe(200);
    expect(h.updateMessage).toHaveBeenCalledWith(
      "C1",
      "2",
      "Не маю відповіді на це.",
      expect.anything(),
    );
  });

  it("mention with threadTs → prepends the thread transcript to the question", async () => {
    h.fetchThreadContext.mockResolvedValue("Контекст треду (Slack):\n[Oleksandr K]: bug details");
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    const mentionReq = {
      surface: "mention",
      conversationKey: "111.222",
      channelId: "C-issue-log",
      userId: "U1",
      incomingTs: "111.900",
      placeholderTs: "111.901",
      threadTs: "111.222",
      question: "створи тікет з цього треду",
    };
    const res = await POST(req(mentionReq));
    expect(res.status).toBe(200);
    expect(h.fetchThreadContext).toHaveBeenCalledWith("C-issue-log", "111.222", ["111.900", "111.901"]);
    expect(h.runSlackTurn).toHaveBeenCalledWith(
      "Контекст треду (Slack):\n[Oleksandr K]: bug details\n\nствори тікет з цього треду",
      [],
      {
        sourceUrl: "https://orientsai.slack.com/archives/C-issue-log/p111222",
        channelId: "C-issue-log",
        threadTs: "111.222",
      },
    );
    // memory stores the ORIGINAL question, not the augmented one
    expect(h.appendTurn).toHaveBeenCalledWith("111.222", "створи тікет з цього треду", "answer");
  });

  it("DM (no threadTs) → never fetches thread context", async () => {
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    await POST(req(base));
    expect(h.fetchThreadContext).not.toHaveBeenCalled();
    expect(h.runSlackTurn).toHaveBeenCalledWith("q", [], { sourceUrl: undefined, channelId: "C1", threadTs: undefined });
  });

  it("thread-context fetch failure → turn still runs on the bare question", async () => {
    h.fetchThreadContext.mockRejectedValue(new Error("slack down"));
    h.runSlackTurn.mockResolvedValue({ kind: "text", text: "answer" });
    const res = await POST(req({ ...base, surface: "mention", threadTs: "111.222" }));
    expect(res.status).toBe(200);
    // context degraded, but the source link still rides along
    expect(h.runSlackTurn).toHaveBeenCalledWith("q", [], {
      sourceUrl: "https://orientsai.slack.com/archives/C1/p111222",
      channelId: "C1",
      threadTs: "111.222",
    });
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "answer", expect.anything());
  });
});
