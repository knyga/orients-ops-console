import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ fetchMessageByTs: vi.fn(), fetchThreadMessages: vi.fn() }));
vi.mock("@/lib/slack", () => {
  class SlackError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
      this.name = "SlackError";
    }
  }
  return { fetchMessageByTs: h.fetchMessageByTs, fetchThreadMessages: h.fetchThreadMessages, SlackError };
});

import { resolveSlackLink, expandSlackLinks, SlackLinkError } from "./slackLinkContext";
import { SlackError } from "@/lib/slack";

const CH = "C08GY2NKF9D";
const MSG = `https://orientsai.slack.com/archives/${CH}/p1785736825822439`;
const REPLY = `https://orientsai.slack.com/archives/${CH}/p1788531440845259?thread_ts=1786084309.782289&cid=${CH}`;

beforeEach(() => {
  h.fetchMessageByTs.mockReset();
  h.fetchThreadMessages.mockReset();
});

describe("resolveSlackLink", () => {
  it("renders a plain (un-threaded) message without fetching a thread", async () => {
    h.fetchMessageByTs.mockResolvedValueOnce({ ts: "1785736825.822439", user: "U1", text: "звіт готовий" });
    const r = await resolveSlackLink(MSG);
    expect(h.fetchMessageByTs).toHaveBeenCalledWith(CH, "1785736825.822439");
    expect(h.fetchThreadMessages).not.toHaveBeenCalled();
    expect(r.thread.messages).toHaveLength(1);
    expect(r.rendered).toContain("звіт готовий");
  });

  it("a reply link fetches the whole thread by its root and marks the reply", async () => {
    h.fetchMessageByTs.mockResolvedValueOnce({ ts: "1788531440.845259", user: "U2", text: "відповідь", threadTs: "1786084309.782289" });
    h.fetchThreadMessages.mockResolvedValueOnce([
      { ts: "1786084309.782289", user: "U1", text: "корінь", threadTs: "1786084309.782289", replyCount: 1 },
      { ts: "1788531440.845259", user: "U2", text: "відповідь", threadTs: "1786084309.782289" },
    ]);
    const r = await resolveSlackLink(REPLY);
    expect(h.fetchThreadMessages).toHaveBeenCalledWith(CH, "1786084309.782289", { maxPages: 2 });
    expect(r.rendered).toContain("]: корінь");
    expect(r.rendered).toMatch(/→ \[.*\]: відповідь/);
  });

  it("a parent-with-replies link (no thread_ts in the URL) still expands the thread", async () => {
    h.fetchMessageByTs.mockResolvedValueOnce({ ts: "1785736825.822439", user: "U1", text: "корінь", threadTs: "1785736825.822439", replyCount: 2 });
    h.fetchThreadMessages.mockResolvedValueOnce([
      { ts: "1785736825.822439", user: "U1", text: "корінь", threadTs: "1785736825.822439", replyCount: 2 },
      { ts: "1785736900.000000", user: "U2", text: "r1", threadTs: "1785736825.822439" },
      { ts: "1785736950.000000", user: "U3", text: "r2", threadTs: "1785736825.822439" },
    ]);
    const r = await resolveSlackLink(MSG);
    expect(r.thread.messages).toHaveLength(3);
    expect(r.rendered).toContain("3 повідомлень");
  });

  it("takes the thread root from Slack's metadata, not from a URL thread_ts that disagrees", async () => {
    // Crafted link: message A's ts + thread B's thread_ts. Slack says A is a plain message.
    h.fetchMessageByTs.mockResolvedValueOnce({ ts: "1788531440.845259", user: "U2", text: "A" });
    const r = await resolveSlackLink(REPLY);
    expect(h.fetchThreadMessages).not.toHaveBeenCalled();
    expect(r.thread.messages.map((m) => m.text)).toEqual(["A"]);
  });

  it("discards a fetched thread that does not contain the linked ts", async () => {
    h.fetchMessageByTs.mockResolvedValueOnce({ ts: "1788531440.845259", user: "U2", text: "A", threadTs: "1786084309.782289" });
    h.fetchThreadMessages.mockResolvedValueOnce([{ ts: "1786084309.782289", user: "U1", text: "B-root" }]);
    const r = await resolveSlackLink(REPLY);
    expect(r.thread.messages.map((m) => m.text)).toEqual(["A"]);
  });

  it("refuses a link outside allowedChannelIds without fetching", async () => {
    await expect(resolveSlackLink(MSG, { allowedChannelIds: ["C_OTHER"] })).rejects.toThrow(/інший канал/);
    expect(h.fetchMessageByTs).not.toHaveBeenCalled();
    h.fetchMessageByTs.mockResolvedValueOnce({ ts: "1785736825.822439", user: "U1", text: "ok" });
    await expect(resolveSlackLink(MSG, { allowedChannelIds: [CH] })).resolves.toBeTruthy();
  });

  it("gives up on a link after the per-link timeout", async () => {
    h.fetchMessageByTs.mockReturnValueOnce(new Promise(() => {}));
    await expect(resolveSlackLink(MSG, { timeoutMs: 20 })).rejects.toThrow(/не встиг/);
  });

  it("rejects a non-permalink with a Ukrainian SlackLinkError", async () => {
    await expect(resolveSlackLink("https://example.com/x")).rejects.toBeInstanceOf(SlackLinkError);
    await expect(resolveSlackLink("https://example.com/x")).rejects.toThrow(/не посилання/);
  });

  it("maps a missing message and a not_in_channel error to Ukrainian reasons", async () => {
    h.fetchMessageByTs.mockResolvedValueOnce(null);
    await expect(resolveSlackLink(MSG)).rejects.toThrow(/не знайдено/);
    h.fetchMessageByTs.mockRejectedValueOnce(new SlackError("Slack conversations.replies error: not_in_channel", 502));
    await expect(resolveSlackLink(MSG)).rejects.toThrow(/бот не в цьому каналі/);
  });
});

describe("expandSlackLinks", () => {
  it("returns null when the text carries no links", async () => {
    expect(await expandSlackLinks("що по джирі?")).toBeNull();
    expect(h.fetchMessageByTs).not.toHaveBeenCalled();
  });

  it("expands each link into one block and keeps going past a failing one", async () => {
    h.fetchMessageByTs
      .mockResolvedValueOnce({ ts: "1785736825.822439", user: "U1", text: "перше" })
      .mockRejectedValueOnce(new SlackError("Slack conversations.replies error: channel_not_found", 502));
    const out = await expandSlackLinks(`глянь <${MSG}> і <${REPLY}|${REPLY}>`);
    expect(out).toContain("Вміст посилань зі Slack");
    expect(out).toContain("]: перше");
    expect(out).toContain(`Посилання: ${REPLY}\n(не вдалося прочитати: бот не в цьому каналі`);
  });

  it("skips links into the current thread (already injected as thread context)", async () => {
    const out = await expandSlackLinks(`${REPLY} — що тут?`, {
      skipThread: { channelId: CH, threadTs: "1786084309.782289" },
    });
    expect(out).toBeNull();
    expect(h.fetchMessageByTs).not.toHaveBeenCalled();
  });

  it("with allowedChannelIds, a foreign-channel link becomes a per-link refusal (no fetch)", async () => {
    const out = await expandSlackLinks(`див. https://orientsai.slack.com/archives/CPRIVATE1/p1785736825822439`, {
      allowedChannelIds: [CH],
    });
    expect(out).toContain("не вдалося прочитати: посилання веде в інший канал");
    expect(h.fetchMessageByTs).not.toHaveBeenCalled();
  });

  it("caps the number of auto-expanded links and says how many were left", async () => {
    h.fetchMessageByTs.mockResolvedValue({ ts: "x", user: "U1", text: "t" });
    const urls = [1, 2, 3, 4].map((i) => `https://orientsai.slack.com/archives/${CH}/p178573682582243${i}`);
    const out = await expandSlackLinks(urls.join(" "), { maxLinks: 2 });
    expect(h.fetchMessageByTs).toHaveBeenCalledTimes(2);
    expect(out).toContain("(ще 2 посилань не розгорнуто");
  });
});
