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
  appendTurn: vi.fn(),
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
vi.mock("@/lib/agentThread", () => ({ agentThreadExists: h.agentThreadExists, appendTurn: h.appendTurn }));

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

  it("refuses a disallowed user on EVERY message, keyed per-message-ts (not swallowed after the first)", async () => {
    h.isAllowedSlackUser.mockReturnValue(false);
    await POST(req(dmEvent("first", { ts: "200.001", eventId: "EvA" })));
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      expect.stringContaining("Вибачте"),
      expect.objectContaining({ key: "agent:U1:200.001" }),
      undefined,
    );

    h.postMessage.mockClear();
    await POST(req(dmEvent("second", { ts: "200.002", eventId: "EvB" })));
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      expect.stringContaining("Вибачте"),
      expect.objectContaining({ key: "agent:U1:200.002" }),
      undefined,
    );
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

  it("registers the self-invoke with the platform waitUntil so the frozen lambda can't drop it", async () => {
    // On Vercel, returning the response freezes the instance; a bare `void fetch`
    // may never leave the process. @vercel/functions waitUntil reads this symbol.
    const waitUntilSpy = vi.fn();
    const sym = Symbol.for("@vercel/request-context");
    (globalThis as Record<symbol, unknown>)[sym] = { get: () => ({ waitUntil: waitUntilSpy }) };
    try {
      let resolveFetch: (() => void) | undefined;
      global.fetch = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = () => resolve(new Response("{}", { status: 200 }));
          }),
      ) as unknown as typeof fetch;

      const res = await POST(req(dmEvent("hello")));
      expect(res.status).toBe(200);
      expect(waitUntilSpy).toHaveBeenCalledTimes(1);
      expect(waitUntilSpy.mock.calls[0][0]).toBeInstanceOf(Promise);
      resolveFetch?.();
    } finally {
      delete (globalThis as Record<symbol, unknown>)[sym];
    }
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

  it("two turns in the same DM conversation get DISTINCT per-message placeholder keys (not deduped by conversationKey)", async () => {
    await POST(req(dmEvent("first question", { ts: "100.001" })));
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "🤔 думаю…",
      expect.objectContaining({ key: "agent:U1:100.001:ph" }),
      undefined,
    );

    h.postMessage.mockClear();
    await POST(req(dmEvent("second question", { ts: "100.002" })));
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "🤔 думаю…",
      expect.objectContaining({ key: "agent:U1:100.002:ph" }),
      undefined,
    );
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

  it('"так" with a pending proposal → claims + applies, posts the result keyed per-message-ts, no self-invoke', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Створено ATP-123: https://x/ATP-123");

    const res = await POST(req(dmEvent("так", { ts: "100.001" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.applied).toBe(true);

    expect(h.claimApply).toHaveBeenCalledWith("prop-1");
    expect(h.applyProposal).toHaveBeenCalledWith("jira_create", pending.params);
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "✅ Створено ATP-123: https://x/ATP-123",
      expect.objectContaining({ feature: "agent", channel: "dm", key: "agent:U1:100.001:apply" }),
      undefined,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a SECOND "так" (new message ts) in the same conversation is not deduped away', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ result 1");
    await POST(req(dmEvent("так", { ts: "100.001" })));
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "✅ result 1",
      expect.objectContaining({ key: "agent:U1:100.001:apply" }),
      undefined,
    );

    h.postMessage.mockClear();
    h.applyProposal.mockResolvedValue("✅ result 2");
    await POST(req(dmEvent("так", { ts: "100.002" })));
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "✅ result 2",
      expect.objectContaining({ key: "agent:U1:100.002:apply" }),
      undefined,
    );
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

  it('"так" where applyProposal rejects → posts a ❌ failure message (no 5xx), does not un-claim', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockRejectedValue(new Error("Calendar API error: insufficient permissions"));

    const res = await POST(req(dmEvent("так")));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.applied).toBe(false);
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      expect.stringContaining("❌ Не вдалося застосувати: Calendar API error: insufficient permissions"),
      expect.objectContaining({ feature: "agent", channel: "dm" }),
      undefined,
    );
  });

  it('"ні" with a pending proposal → CANCELLED + "Скасовано.", keyed per-message-ts, no self-invoke', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("cancel");

    const res = await POST(req(dmEvent("ні", { ts: "100.001" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cancelled).toBe(true);

    expect(h.setState).toHaveBeenCalledWith("prop-1", "CANCELLED");
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      "Скасовано.",
      expect.objectContaining({ key: "agent:U1:100.001:cancel" }),
      undefined,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("other text with a pending proposal → SUPERSEDED + notice (keyed per-message-ts) + defers a new turn", async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("other");

    const res = await POST(req(dmEvent("actually make it a bug instead", { ts: "100.001" })));
    expect(res.status).toBe(200);

    expect(h.setState).toHaveBeenCalledWith("prop-1", "SUPERSEDED");
    expect(h.postMessage).toHaveBeenNthCalledWith(
      1,
      "D1",
      "Скасував попередню пропозицію, обробляю новий запит.",
      expect.objectContaining({ key: "agent:U1:100.001:supersede" }),
      undefined,
    );
    expect(h.postMessage).toHaveBeenNthCalledWith(
      2,
      "D1",
      "🤔 думаю…",
      expect.objectContaining({ key: "agent:U1:100.001:ph" }),
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

  it('"так" confirm outcome is recorded into agent memory (appendTurn) so a follow-up question sees it', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Створено ATP-123");

    await POST(req(dmEvent("так", { ts: "100.001" })));
    expect(h.appendTurn).toHaveBeenCalledWith("D1", "так", "✅ Створено ATP-123");
  });

  it('"ні" cancel outcome is recorded into agent memory (appendTurn)', async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("cancel");

    await POST(req(dmEvent("ні", { ts: "100.001" })));
    expect(h.appendTurn).toHaveBeenCalledWith("D1", "ні", "Скасовано.");
  });

  it("an approver-gate refusal on a money-affecting proposal is CANCELLED, never applied, and recorded into agent memory", async () => {
    // Finding 4 regression: a non-approver confirming a field_loss_set proposal
    // must hit gateProposalApply's refusal branch (CANCELLED, no applyProposal
    // call, refusal text posted) rather than silently applying.
    const lossPending = { ...pending, id: "loss-1", kind: "field_loss_set" as const };
    h.readPendingProposal.mockResolvedValue(lossPending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.approverFor.mockReturnValue(undefined); // U1 is not an authorized approver

    const res = await POST(req(dmEvent("так", { ts: "100.001" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.refused).toBe("approver-gate");

    expect(h.setState).toHaveBeenCalledWith("loss-1", "CANCELLED");
    expect(h.claimApply).not.toHaveBeenCalled();
    expect(h.applyProposal).not.toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledWith(
      "D1",
      expect.stringContaining("затверджувач"),
      expect.objectContaining({ key: "agent:U1:100.001:gate" }),
      undefined,
    );
    expect(h.appendTurn).toHaveBeenCalledWith("D1", "так", expect.stringContaining("затверджувач"));
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

  it("thread reply 'так' by requester applies the pending proposal, keyed by the reply's own ts (not the thread key)", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Створено ATP-1: url");

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U1", text: "так", channel: "C1", replyTs: "300.111" })),
    );
    expect(res.status).toBe(200);

    expect(h.agentThreadExists).toHaveBeenCalledWith("T1");
    expect(h.readPendingProposal).toHaveBeenCalledWith("T1"); // conversationKey (thread) unchanged for memory/proposal lookup
    expect(h.claimApply).toHaveBeenCalledWith("p1");
    expect(h.applyProposal).toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledWith(
      "C1",
      "✅ Створено ATP-1: url",
      expect.objectContaining({ key: "agent:U1:300.111:apply" }),
      "T1",
    );
    // fetch (self-invoke) NOT called — confirm is inline.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("plain thread reply with NO pending proposal is ignored — no placeholder, no defer, no event claim (mention-only)", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(null);

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U1", text: "додай задачу в наступний спринт", channel: "C1", replyTs: "300.001" })),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ignored).toBe("mention-required");

    expect(h.postMessage).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(h.claimSlackEvent).not.toHaveBeenCalled();
  });

  /**
   * 2026-09-01 (ATP-1891): the model answered with TEXT that imitated a
   * proposal («Продовжити? (так/ні)») — no PENDING row existed, so the user's
   * «так» died in the silent mention-required branch and they thought the bot
   * swallowed a real confirmation. A confirm/cancel word from an ALLOWED user
   * with nothing pending must get a visible notice; bystanders stay silent.
   */
  it("thread 'так' from an allowed user with NO pending proposal → visible no-proposal notice", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(null);
    h.classifyDmReply.mockReturnValue("confirm");

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U1", text: "так", channel: "C1", replyTs: "300.005" })),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.noPending).toBe(true);

    expect(h.claimSlackEvent).toHaveBeenCalled(); // deduped like any handled event
    expect(h.postMessage).toHaveBeenCalledWith(
      "C1",
      expect.stringContaining("Немає активної пропозиції"),
      expect.objectContaining({ key: "agent:U1:300.005:no-pending" }),
      "T1",
    );
    expect(global.fetch).not.toHaveBeenCalled(); // never starts a new turn
  });

  it("thread 'так' from a NON-allowed user with NO pending proposal stays silent", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(null);
    h.classifyDmReply.mockReturnValue("confirm");
    h.isAllowedSlackUser.mockReturnValue(false);

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U9", text: "так", channel: "C1", replyTs: "300.006" })),
    );
    const json = await res.json();
    expect(json.ignored).toBe("mention-required");
    expect(h.postMessage).not.toHaveBeenCalled();
  });

  it("plain thread reply that is not так/ні while a proposal is pending → ignored; proposal stays PENDING (no supersede)", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("other");

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U1", text: "а ще додай опис", channel: "C1", replyTs: "300.003" })),
    );
    const json = await res.json();
    expect(json.ignored).toBe("mention-required");

    expect(h.setState).not.toHaveBeenCalled(); // no SUPERSEDED
    expect(h.postMessage).not.toHaveBeenCalled(); // no «Скасував попередню…», no placeholder
    expect(global.fetch).not.toHaveBeenCalled();
    expect(h.claimSlackEvent).not.toHaveBeenCalled();
  });

  it("a non-allowlisted user's plain thread reply is ignored WITHOUT a refusal post", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(null);
    h.isAllowedSlackUser.mockReturnValue(false);

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U9", text: "привіт боте", channel: "C1", replyTs: "300.004" })),
    );
    const json = await res.json();
    expect(json.ignored).toBe("mention-required");
    expect(h.postMessage).not.toHaveBeenCalled();
  });

  it("an @mention with a pending proposal still supersedes it and defers a new turn (mention path unchanged)", async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.classifyDmReply.mockReturnValue("other");

    const res = await POST(
      req(mentionEvent({ ts: "T1", threadTs: "T1", user: "U1", channel: "C1", text: "<@U0BOT> зроби інакше" })),
    );
    expect(res.status).toBe(200);
    expect(h.setState).toHaveBeenCalledWith("p1", "SUPERSEDED");
    expect(h.postMessage).toHaveBeenCalledWith(
      "C1",
      "Скасував попередню пропозицію, обробляю новий запит.",
      expect.objectContaining({ key: "agent:U1:T1:supersede" }),
      "T1",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1); // the deferred new turn
  });

  it("thread reply by a non-requester NON-APPROVER is ignored while a proposal is pending", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(pending);
    h.isApprover.mockReturnValue(false);

    const res = await POST(req(actionableEvent({ threadTs: "T1", user: "U2", text: "так", channel: "C1" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ignored).toBe("not-requester");

    expect(h.claimApply).not.toHaveBeenCalled();
    expect(h.setState).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("thread reply 'так' by a non-requester APPROVER applies the pending proposal", async () => {
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(pending);
    h.isApprover.mockReturnValue(true);
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Створено ATP-1: url");

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U_APPROVER", text: "так", channel: "C1", replyTs: "300.222" })),
    );
    expect(res.status).toBe(200);

    expect(h.claimApply).toHaveBeenCalledWith("p1");
    expect(h.applyProposal).toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledWith(
      "C1",
      "✅ Створено ATP-1: url",
      expect.objectContaining({ key: "agent:U_APPROVER:300.222:apply" }),
      "T1",
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("@mention by an allowed non-requester non-approver while a proposal is pending → waiting notice, proposal untouched", async () => {
    h.readPendingProposal.mockResolvedValue(pending);
    h.isApprover.mockReturnValue(false);

    const res = await POST(
      req(mentionEvent({ ts: "300.333", threadTs: "T1", user: "U2", channel: "C1", text: "<@U0BOT> так" })),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ignored).toBe("not-authorized-for-pending");

    expect(h.postMessage).toHaveBeenCalledWith(
      "C1",
      expect.stringContaining("<@U1>"),
      expect.objectContaining({ key: "agent:U2:300.333:wait" }),
      "T1",
    );
    expect(h.claimApply).not.toHaveBeenCalled();
    expect(h.setState).not.toHaveBeenCalled(); // stays PENDING
    expect(global.fetch).not.toHaveBeenCalled(); // no new turn
  });

  it("confirm gates the approver-gated kind on the CONFIRMER, not the requester", async () => {
    const gatedPending = { ...pending, kind: "field_loss_set" as const, proposedBy: "U_REQ" };
    h.agentThreadExists.mockResolvedValue(true);
    h.readPendingProposal.mockResolvedValue(gatedPending);
    h.isApprover.mockReturnValue(true);
    h.approverFor.mockImplementation((id: string) =>
      id === "U_APPROVER" ? { userId: "U_APPROVER", name: "Oleksandr K", role: "CEO/CTO" } : undefined,
    );
    h.classifyDmReply.mockReturnValue("confirm");
    h.claimApply.mockResolvedValue(true);
    h.applyProposal.mockResolvedValue("✅ Записано");

    const res = await POST(
      req(actionableEvent({ threadTs: "T1", user: "U_APPROVER", text: "так", channel: "C1", replyTs: "300.444" })),
    );
    expect(res.status).toBe(200);

    // approverFor resolved against the confirmer's id → gate passes and `by` is theirs.
    expect(h.approverFor).toHaveBeenCalledWith("U_APPROVER");
    expect(h.applyProposal).toHaveBeenCalledWith("field_loss_set", expect.objectContaining({ by: "Oleksandr K" }));
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
