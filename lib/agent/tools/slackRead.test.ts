import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ resolveSlackLink: vi.fn() }));
vi.mock("../slackLinkContext", () => {
  class SlackLinkError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SlackLinkError";
    }
  }
  return { resolveSlackLink: h.resolveSlackLink, SlackLinkError };
});

import { slackReadTools } from "./slackRead";
import { SlackLinkError } from "../slackLinkContext";

const tool = slackReadTools[0];

beforeEach(() => h.resolveSlackLink.mockReset());

describe("slack_read_link", () => {
  it("is a read tool that returns the rendered message", async () => {
    expect(tool.name).toBe("slack_read_link");
    expect(tool.kind).toBe("read");
    h.resolveSlackLink.mockResolvedValueOnce({ rendered: "RENDERED" });
    const r = await tool.run!({ url: " https://orientsai.slack.com/archives/C1/p1785736825822439 " });
    expect(h.resolveSlackLink).toHaveBeenCalledWith("https://orientsai.slack.com/archives/C1/p1785736825822439");
    expect(r).toEqual({ ok: true, content: "RENDERED" });
  });
  it("turns a SlackLinkError into a non-throwing Ukrainian tool result", async () => {
    h.resolveSlackLink.mockRejectedValueOnce(new SlackLinkError("бот не в цьому каналі"));
    const r = await tool.run!({ url: "https://x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Не вдалося прочитати посилання: бот не в цьому каналі");
  });
  it("asks for a url when none is given", async () => {
    const r = await tool.run!({});
    expect(r.ok).toBe(false);
    expect(h.resolveSlackLink).not.toHaveBeenCalled();
  });
});
