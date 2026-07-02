import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  runSlackTurn: vi.fn(),
  askAgent: vi.fn(),
  loadTranscript: vi.fn(),
  appendTurn: vi.fn(),
  insertPending: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock("@/lib/agent/slackTurn", () => ({ runSlackTurn: h.runSlackTurn }));
vi.mock("@/lib/agent/slackAgent", () => ({ askAgent: h.askAgent }));
vi.mock("@/lib/agentThread", () => ({
  loadTranscript: h.loadTranscript,
  appendTurn: h.appendTurn,
}));
vi.mock("@/lib/agentProposals", () => ({ insertPending: h.insertPending }));
vi.mock("@/lib/slack", () => ({ updateMessage: h.updateMessage }));

import { POST } from "./route";

const SECRET = "s3cret";
beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.loadTranscript.mockResolvedValue([]);
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

  it("mention → calls askAgent, edits placeholder, no transcript load", async () => {
    h.askAgent.mockResolvedValue("mention answer");
    const mentionReq = { ...base, surface: "mention" };
    const res = await POST(req(mentionReq));
    expect(res.status).toBe(200);
    expect(h.askAgent).toHaveBeenCalledWith("q");
    expect(h.updateMessage).toHaveBeenCalledWith("C1", "2", "mention answer", expect.anything());
    expect(h.loadTranscript).not.toHaveBeenCalled();
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
});
