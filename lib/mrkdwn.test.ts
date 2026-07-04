import { describe, expect, it } from "vitest";
import { markdownToMrkdwn } from "./mrkdwn";

describe("markdownToMrkdwn", () => {
  it("converts **bold** to Slack *bold*", () => {
    expect(markdownToMrkdwn("це **жирний** текст")).toBe("це *жирний* текст");
  });

  it("converts __bold__ to Slack *bold*", () => {
    expect(markdownToMrkdwn("__bold__ word")).toBe("*bold* word");
  });

  it("converts ***bold italic*** to *_text_*", () => {
    expect(markdownToMrkdwn("***both***")).toBe("*_both_*");
  });

  it("converts ~~strike~~ to ~strike~", () => {
    expect(markdownToMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("converts markdown links to Slack links", () => {
    expect(markdownToMrkdwn("see [the doc](https://example.com/x)")).toBe(
      "see <https://example.com/x|the doc>",
    );
  });

  it("converts ATX headings to bold lines", () => {
    expect(markdownToMrkdwn("## Оновлення\ntext")).toBe("*Оновлення*\ntext");
  });

  it("converts leading - and * list markers to bullets, keeping indentation", () => {
    expect(markdownToMrkdwn("- перший\n  - вкладений\n* другий")).toBe(
      "• перший\n  • вкладений\n• другий",
    );
  });

  it("handles the real bot reply shape (bullet + bold key)", () => {
    expect(markdownToMrkdwn("- **ATP-1685** — [Done] Натренувати")).toBe(
      "• *ATP-1685* — [Done] Натренувати",
    );
  });

  it("leaves inline code spans untouched", () => {
    expect(markdownToMrkdwn("run `npm run **not bold**` now")).toBe(
      "run `npm run **not bold**` now",
    );
  });

  it("leaves fenced code blocks untouched", () => {
    const s = "before\n```\n- **raw**\n```\nafter **b**";
    expect(markdownToMrkdwn(s)).toBe("before\n```\n- **raw**\n```\nafter *b*");
  });

  it("leaves plain text, existing mrkdwn and numbered lists alone", () => {
    const s = "1. один\n2. два\n*вже жирний* і _курсив_";
    expect(markdownToMrkdwn(s)).toBe(s);
  });
});
