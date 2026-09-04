import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchThreadMessages, fetchMessageByTs } from "./slack";

function slackResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

describe("fetchThreadMessages", () => {
  beforeEach(() => {
    process.env.SLACK_TOKEN = "xoxb-test";
    vi.restoreAllMocks();
  });

  it("pages conversations.replies and keeps the parent first", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          messages: [
            { ts: "1.000", user: "U1", text: "parent" },
            { ts: "2.000", user: "U2", text: "reply one" },
          ],
          response_metadata: { next_cursor: "abc" },
        }),
      )
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          messages: [{ ts: "3.000", bot_id: "B1", text: "bot reply" }],
        }),
      );

    const out = await fetchThreadMessages("C123", "1.000");
    expect(out).toEqual([
      { ts: "1.000", user: "U1", botId: undefined, text: "parent" },
      { ts: "2.000", user: "U2", botId: undefined, text: "reply one" },
      { ts: "3.000", user: undefined, botId: "B1", text: "bot reply" },
    ]);

    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("conversations.replies");
    expect(firstUrl).toContain("channel=C123");
    expect(firstUrl).toContain("ts=1.000");
    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain("cursor=abc");
  });

  it("throws SlackError when Slack rejects the call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      slackResponse({ ok: false, error: "channel_not_found" }),
    );
    await expect(fetchThreadMessages("C404", "1.000")).rejects.toThrow(/channel_not_found/);
  });
});

describe("fetchMessageByTs", () => {
  beforeEach(() => {
    process.env.SLACK_TOKEN = "xoxb-test";
    vi.restoreAllMocks();
  });

  it("uses conversations.replies and filters to the exact ts (a parent page carries replies too)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      slackResponse({
        ok: true,
        messages: [
          { ts: "1.000", user: "U1", text: "parent", thread_ts: "1.000", reply_count: 1 },
          { ts: "2.000", user: "U2", text: "reply", thread_ts: "1.000" },
        ],
      }),
    );
    const out = await fetchMessageByTs("C123", "1.000");
    expect(out).toEqual({ ts: "1.000", user: "U1", botId: undefined, text: "parent", threadTs: "1.000", replyCount: 1 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("conversations.replies");
    expect(url).toContain("ts=1.000");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to an inclusive conversations.history window on thread_not_found, null when still absent", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(slackResponse({ ok: false, error: "thread_not_found" }))
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [] }));
    expect(await fetchMessageByTs("C123", "9.000")).toBeNull();
    const second = String(fetchMock.mock.calls[1][0]);
    expect(second).toContain("conversations.history");
    expect(second).toContain("oldest=9.000");
    expect(second).toContain("latest=9.000");
    expect(second).toContain("inclusive=true");
  });

  it("propagates access errors instead of masking them as not-found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(slackResponse({ ok: false, error: "not_in_channel" }));
    await expect(fetchMessageByTs("C123", "1.000")).rejects.toThrow(/not_in_channel/);
  });
});

describe("fetchThreadMessages maxPages", () => {
  it("stops after maxPages even when Slack offers a next_cursor", async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    vi.restoreAllMocks();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      slackResponse({ ok: true, messages: [{ ts: "1.000", user: "U1", text: "p" }], response_metadata: { next_cursor: "more" } }),
    );
    const out = await fetchThreadMessages("C123", "1.000", { maxPages: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
  });
});
