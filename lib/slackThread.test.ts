import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchThreadMessages } from "./slack";

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
