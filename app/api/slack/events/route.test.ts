import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  verifySlackSignature: vi.fn(),
  findPublishedByTs: vi.fn(),
  findAskByTs: vi.fn(),
  approverFor: vi.fn(),
  isApprover: vi.fn(),
  applyInstructionReply: vi.fn(),
  applyAnswerReply: vi.fn(),
  permalinkFor: vi.fn(),
  postMessage: vi.fn(),
  formatWebhookFailureNotice: vi.fn(),
  formatDmHelp: vi.fn(),
  isAllowedSlackUser: vi.fn(),
  classifyDmReply: vi.fn(),
  readPendingProposal: vi.fn(),
  claimApply: vi.fn(),
  setState: vi.fn(),
  applyProposal: vi.fn(),
  selfOrigin: vi.fn(),
  claimSlackEvent: vi.fn(),
  agentThreadExists: vi.fn(),
}));

vi.mock("@/lib/slackSignature", () => ({ verifySlackSignature: h.verifySlackSignature }));
vi.mock("@/lib/slackChannels", () => ({
  TRACKED_CHANNELS: [{ id: "C_TRACKED", name: "field-qa" }],
}));
vi.mock("@/lib/published", () => ({ findPublishedByTs: h.findPublishedByTs }));
vi.mock("@/lib/asks", () => ({ findAskByTs: h.findAskByTs }));
vi.mock("@/lib/approvers", () => ({
  approverFor: h.approverFor,
  isApprover: h.isApprover,
}));
vi.mock("@/lib/applyInstructionReply", () => ({ applyInstructionReply: h.applyInstructionReply }));
vi.mock("@/lib/applyAnswer", () => ({ applyAnswerReply: h.applyAnswerReply }));
vi.mock("@/lib/slack", () => ({
  permalinkFor: h.permalinkFor,
  postMessage: h.postMessage,
}));
vi.mock("@/lib/webhookNotice", () => ({ formatWebhookFailureNotice: h.formatWebhookFailureNotice }));
vi.mock("@/lib/dmHelp", () => ({ formatDmHelp: h.formatDmHelp }));
vi.mock("@/lib/agent/access", () => ({
  isAllowedSlackUser: h.isAllowedSlackUser,
  AGENT_REFUSAL_UK: "Вибачте, я можу відповідати лише авторизованим користувачам.",
}));
vi.mock("@/lib/agentDm", () => ({ classifyDmReply: h.classifyDmReply }));
vi.mock("@/lib/agentProposals", () => ({
  readPendingProposal: h.readPendingProposal,
  claimApply: h.claimApply,
  setState: h.setState,
}));
vi.mock("@/lib/proposalExecutor", () => ({ applyProposal: h.applyProposal }));
vi.mock("@/lib/selfOrigin", () => ({ selfOrigin: h.selfOrigin }));
vi.mock("@/lib/slackEventClaim", () => ({ claimSlackEvent: h.claimSlackEvent }));
vi.mock("@/lib/agentThread", () => ({ agentThreadExists: h.agentThreadExists }));

import { POST } from "./route";

const SIGNING_SECRET = "sign-secret";
const AGENT_SECRET = "agent-secret";

function req(body: unknown): Request {
  return new Request("https://bot.example/api/slack/events", {
    method: "POST",
    headers: {
      "x-slack-signature": "v0=whatever",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function dmEvent(text: string, opts: Partial<{ eventId: string; user: string; ts: string }> = {}) {
  return {
    type: "event_callback",
    event_id: opts.eventId ?? "Ev1",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: opts.user ?? "U1",
      text,
      ts: opts.ts ?? "100.001",
    },
  };
}

function mentionThreadReplyEvent() {
  return {
    type: "event_callback",
    event_id: "Ev2",
    event: {
      type: "app_mention",
      channel: "C1",
      user: "U1",
      text: "<@BOT> так",
      ts: "200.002",
      thread_ts: "200.001",
    },
  };
}

/** A plain human thread reply (no bot mention) — `parseSlackEvent`'s "actionable" kind. */
function actionableEvent(opts: {
  threadTs: string;
  user: string;
  text: string;
  channel: string;
  eventId?: string;
  replyTs?: string;
}) {
  return {
    type: "event_callback",
    event_id: opts.eventId ?? "Ev3",
    event: {
      type: "message",
      channel: opts.channel,
      user: opts.user,
      text: opts.text,
      ts: opts.replyTs ?? "300.002",
      thread_ts: opts.threadTs,
    },
  };
}

/** A top-level @mention (thread_ts === ts) that starts a new agent turn. */
function mentionEvent(opts: { ts: string; threadTs: string; user: string; channel: string; text: string; eventId?: string }) {
  return {
    type: "event_callback",
    event_id: opts.eventId ?? "Ev4",
    event: {
      type: "app_mention",
      channel: opts.channel,
      user: opts.user,
      text: opts.text,
      ts: opts.ts,
      thread_ts: opts.threadTs,
    },
  };
}

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  process.env.AGENT_RUN_SECRET = AGENT_SECRET;
  h.verifySlackSignature.mockReturnValue(true);
  h.claimSlackEvent.mockResolvedValue(true);
  h.isAllowedSlackUser.mockReturnValue(true);
  h.postMessage.mockResolvedValue("PLACEHOLDER_TS");
  h.readPendingProposal.mockResolvedValue(null);
  h.selfOrigin.mockReturnValue("https://bot.example");
  h.findPublishedByTs.mockResolvedValue(null);
  h.findAskByTs.mockResolvedValue(null);
  h.formatDmHelp.mockReturnValue("HELP TEXT");
  h.agentThreadExists.mockResolvedValue(false);
  global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch;
});

describe("POST /api/slack/events — DM help + refusal (C.1, unchanged)", () => {
  it("replies with the help cheat sheet on a bare DM", async () => {
    const res = await POST(req(dmEvent("")));
    expect(res.status).toBe(200);
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "HELP TEXT",
      expect.objectContaining({ feature: "help", channel: "dm" }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("replies with help on /help and допомога variants", async () => {
    await POST(req(dmEvent("допомога")));
    expect(h.postMessage).toHaveBeenCalledWith("D1", "HELP TEXT", expect.anything());
  });

  it("refuses a disallowed user on a DM question (no pending)", async () => {
    h.isAllowedSlackUser.mockReturnValue(false);
    const res = await POST(req(dmEvent("what happened yesterday?")));
    expect(res.status).toBe(200);
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      expect.stringContaining("Вибачте"),
      expect.objectContaining({ feature: "agent", channel: "dm" }),
      undefined,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/slack/events — mention verdict/ask-thread deferral (C.1, unchanged)", () => {
  it("skips the agent when the mention is a reply in a published-verdict thread", async () => {
    h.findPublishedByTs.mockResolvedValue({ entry: { date: "2026-06-30" }, period: "2026-06" });
    const res = await POST(req(mentionThreadReplyEvent()));
    const json = await res.json();
    expect(json.skipped).toBe("mention-in-verdict-or-ask-thread");
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips the agent when the mention is a reply in an ask thread", async () => {
    h.findAskByTs.mockResolvedValue({ record: { date: "2026-06-30" }, period: "2026-06" });
    const res = await POST(req(mentionThreadReplyEvent()));
    const json = await res.json();
    expect(json.skipped).toBe("mention-in-verdict-or-ask-thread");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("defers a top-level mention (not a verdict/ask thread reply) to the agent", async () => {
    const event = mentionThreadReplyEvent();
    event.event.thread_ts = event.event.ts; // top-level mention: threadTs === ts
    const res = await POST(req(event));
    expect(res.status).toBe(200);
    expect(h.findPublishedByTs).not.toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledWith(
      "C1",
      "🤔 думаю…",
      expect.objectContaining({ feature: "agent", channel: "mention" }),
      event.event.ts,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://bot.example/api/agent/run",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("POST /api/slack/events — DM agent: fast ack + placeholder + self-invoke defer (C.2)", () => {
  it("new question, no pending proposal → posts placeholder, fires self-invoke, 200s immediately", async () => {
    const res = await POST(req(dmEvent("create a ticket for Andrii")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deferred).toBe(true);

    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "🤔 думаю…",
      expect.objectContaining({ feature: "agent", channel: "dm" }),
      undefined,
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://bot.example/api/agent/run");
    expect(init.method).toBe("POST");
    expect(init.headers["x-agent-secret"]).toBe(AGENT_SECRET);
    const sentBody = JSON.parse(init.body);
    expect(sentBody).toMatchObject({
      surface: "dm",
      channelId: "D1",
      userId: "U1",
      placeholderTs: "PLACEHOLDER_TS",
      question: "create a ticket for Andrii",
    });
  });

  it("does not await the self-invoke fetch before returning (fire-and-forget)", async () => {
    let resolveFetch: (() => void) | undefined;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve(new Response("{}", { status: 200 }));
        }),
    ) as unknown as typeof fetch;

    const res = await POST(req(dmEvent("hello")));
    expect(res.status).toBe(200);
    // The route already returned; the fetch promise is still pending.
    expect(resolveFetch).toBeDefined();
    resolveFetch?.();
  });

  it("logs and still acks if AGENT_RUN_SECRET is unset (placeholder stays visible)", async () => {
    delete process.env.AGENT_RUN_SECRET;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req(dmEvent("hello")));
    expect(res.status).toBe(200);
    expect(h.postMessage).toHaveBeenCalled(); // placeholder still posted
    expect(global.fetch).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("AGENT_RUN_SECRET"));
    errSpy.mockRestore();
  });
});

describe("POST /api/slack/events — DM confirm-first proposal state machine (C.2)", () => {
  const pending = {
    id: "prop-1",
    channelId: "D1",
    kind: "jira_create" as const,
    params: { projectKey: "ATP", summary: "x" },
    summaryUk: "Створити ATP-123: x",
    proposedBy: "U1",
    state: "PENDING" as const,
    createdAt: "2026-07-01T00:00:00Z",
    resolvedAt: null,
  };

  it('"так" with a pending proposal → claims + applies, posts the result, no self-invoke', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Створено ATP-123: https://x/ATP-123");

    const res = await POST(req(dmEvent("так")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.applied).toBe(true);

    expect(h.claimApply).toHaveBeenCalledWith("prop-1");
    expect(h.applyProposal).toHaveBeenCalledWith("jira_create", pending.params);
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "✅ Створено ATP-123: https://x/ATP-123",
      expect.objectContaining({ feature: "agent", channel: "dm" }),
      undefined,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('"так" losing the atomic claim race → posts "Вже застосовано." without re-applying', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(false);

    const res = await POST(req(dmEvent("так")));
    expect(res.status).toBe(200);
    expect(h.applyProposal).not.toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledWith("D1", "Вже застосовано.", expect.anything(), undefined);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('"ні" with a pending proposal → CANCELLED + "Скасовано.", no self-invoke', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("cancel");

    const res = await POST(req(dmEvent("ні")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cancelled).toBe(true);

    expect(h.setState).toHaveBeenCalledWith("prop-1", "CANCELLED");
    expect(h.postMessage).toHaveBeenCalledWith("D1", "Скасовано.", expect.anything(), undefined);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("other text with a pending proposal → SUPERSEDED + notice + defers a new turn", async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("other");

    const res = await POST(req(dmEvent("actually make it a bug instead")));
    expect(res.status).toBe(200);

    expect(h.setState).toHaveBeenCalledWith("prop-1", "SUPERSEDED");
    expect(h.postMessage).toHaveBeenNthCalledWith(
      1,
      "D1",
      "Скасував попередню пропозицію, обробляю новий запит.",
      expect.anything(),
      undefined,
    );
    expect(h.postMessage).toHaveBeenNthCalledWith(
      2,
      "D1",
      "🤔 думаю…",
      expect.anything(),
      undefined,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a disallowed user even with a pending proposal (gate before state machine)", async () => {
    h.isAllowedSlackUser.mockReturnValue(false);
    h.readPendingProposal.mockResolvedValue(pending);

    const res = await POST(req(dmEvent("так")));
    expect(res.status).toBe(200);
    expect(h.readPendingProposal).not.toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      expect.stringContaining("Вибачте"),
      expect.anything(),
      undefined,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/slack/events — plain thread-reply agent branch + requester-gating (C.2 mention delta)", () => {
  const pending = {
    id: "p1",
    channelId: "T1",
    kind: "jira_create" as const,
    params: {},
    summaryUk: "Створити ATP-1",
    proposedBy: "U1",
    state: "PENDING" as const,
    createdAt: "2026-07-01T00:00:00Z",
    resolvedAt: null,
  };

  it("thread reply 'так' by requester applies the pending proposal", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Створено ATP-1: url");

    const res = await POST(req(actionableEvent({ threadTs: "T1", user: "U1", text: "так", channel: "C1" })));
    expect(res.status).toBe(200);

    expect(h.agentThreadExists).toHaveBeenCalledWith("T1");
    expect(h.readPendingProposal).toHaveBeenCalledWith("T1");
    expect(h.claimApply).toHaveBeenCalledWith("p1");
    expect(h.applyProposal).toHaveBeenCalled();
    // fetch (self-invoke) NOT called — confirm is inline.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("thread reply by a non-requester is ignored while a proposal is pending", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(pending);

    const res = await POST(req(actionableEvent({ threadTs: "T1", user: "U2", text: "так", channel: "C1" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ignored).toBe("not-requester");

    expect(h.claimApply).not.toHaveBeenCalled();
    expect(h.setState).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips the message sibling of an @mention in an agent thread", async () => {
    const res = await POST(req(actionableEvent({ threadTs: "T1", user: "U1", text: "<@U0BOT> ще задача", channel: "C1" })));
    expect(res.status).toBe(200);
    // The mention-token-leading sibling is not routed through the agent branch;
    // it falls through to the tracked-channel path (C1 is untracked → skipped).
    expect(h.agentThreadExists).not.toHaveBeenCalled();
    expect(h.claimApply).not.toHaveBeenCalled();
  });

  it("mention defers a turn keyed by thread_ts", async () => {
    const res = await POST(
      req(mentionEvent({ ts: "M1", threadTs: "M1", user: "U1", channel: "C1", text: "<@U0BOT> створи" })),
    );
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.conversationKey).toBe("M1");
    expect(sentBody.surface).toBe("mention");
  });
});
