import { describe, it, expect } from "vitest";
import {
  parseSlackPermalink,
  extractSlackPermalinks,
  renderLinkedThread,
  formatLinkBlocks,
  kyivTimeOf,
} from "./slackLinks";

// U08G4EC244X is Oleksandr K in the real lib/people.ts registry.
const KNOWN = "U08G4EC244X";
const MSG = "https://orientsai.slack.com/archives/C08GY2NKF9D/p1785736825822439";
const REPLY =
  "https://orientsai.slack.com/archives/C08GY2NKF9D/p1788531440845259?thread_ts=1786084309.782289&cid=C08GY2NKF9D";

describe("parseSlackPermalink", () => {
  it("parses a plain message link into channel + ts", () => {
    expect(parseSlackPermalink(MSG)).toEqual({
      channelId: "C08GY2NKF9D",
      ts: "1785736825.822439",
      threadTs: undefined,
      url: MSG,
    });
  });
  it("keeps a reply link's thread_ts (the ROOT) apart from the message ts", () => {
    const r = parseSlackPermalink(REPLY);
    expect(r?.ts).toBe("1788531440.845259");
    expect(r?.threadTs).toBe("1786084309.782289");
    expect(r?.channelId).toBe("C08GY2NKF9D");
  });
  it("drops thread_ts when it equals the message ts (a parent's own link)", () => {
    const r = parseSlackPermalink(`${MSG}?thread_ts=1785736825.822439&cid=C08GY2NKF9D`);
    expect(r?.threadTs).toBeUndefined();
  });
  it("strips Slack's <url|label> and <url> wrapping", () => {
    expect(parseSlackPermalink(`<${MSG}|${MSG}>`)?.ts).toBe("1785736825.822439");
    expect(parseSlackPermalink(`<${MSG}>`)?.ts).toBe("1785736825.822439");
  });
  it("rejects non-Slack and non-message URLs", () => {
    expect(parseSlackPermalink("https://example.com/archives/C08GY2NKF9D/p1785736825822439")).toBeNull();
    expect(parseSlackPermalink("https://orientsai.slack.com/archives/C08GY2NKF9D")).toBeNull();
    expect(parseSlackPermalink("hello")).toBeNull();
  });
});

describe("extractSlackPermalinks", () => {
  it("finds every distinct link in Slack-formatted text, in order", () => {
    const text = `подивись <${REPLY}|${REPLY}> і ще <${MSG}> та знову ${MSG}`;
    const refs = extractSlackPermalinks(text);
    expect(refs.map((r) => r.ts)).toEqual(["1788531440.845259", "1785736825.822439"]);
    expect(refs[0].threadTs).toBe("1786084309.782289");
    expect(refs[0].url).toBe(REPLY);
  });
  it("returns [] for text without links", () => {
    expect(extractSlackPermalinks("що там по джирі?")).toEqual([]);
  });
});

describe("renderLinkedThread", () => {
  it("renders a single message with the roster name and Kyiv time", () => {
    const out = renderLinkedThread({
      channelId: "C1",
      messages: [{ ts: "1785736825.822439", user: KNOWN, text: "привіт" }],
      linkedTs: "1785736825.822439",
    });
    expect(out).toContain("Повідомлення у Slack (<#C1>)");
    expect(out).toContain(`→ [Oleksandr K · ${kyivTimeOf("1785736825.822439")}]: привіт`);
  });
  it("renders a thread oldest-first and marks the linked reply", () => {
    const out = renderLinkedThread({
      channelId: "C1",
      messages: [
        { ts: "1.000000", user: "U_X", text: "root" },
        { ts: "2.000000", botId: "B1", text: "bot reply" },
        { ts: "3.000000", user: KNOWN, text: "linked" },
      ],
      linkedTs: "3.000000",
    });
    const lines = out.split("\n");
    expect(lines[0]).toContain("Тред у Slack (<#C1>, 3 повідомлень");
    expect(lines[1]).toMatch(/^\[<@U_X> · .*\]: root$/);
    expect(lines[2]).toMatch(/^\[бот · .*\]: bot reply$/);
    expect(lines[3]).toMatch(/^→ \[Oleksandr K · .*\]: linked$/);
  });
  it("caps around the linked message: sheds oldest first, then newest, never the linked one", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ ts: `${i + 1}.000000`, user: "U", text: `m${i + 1}` }));
    const out = renderLinkedThread({ channelId: "C1", messages, linkedTs: "8.000000" }, { maxMessages: 3 });
    expect(out).toContain("(7 старіших повідомлень пропущено)");
    expect(out).toContain("→ [<@U>");
    expect(out).toContain("]: m8");
    expect(out).toContain("]: m9");
    expect(out).toContain("]: m10");
    expect(out).not.toContain("]: m7");
    const out2 = renderLinkedThread({ channelId: "C1", messages, linkedTs: "1.000000" }, { maxMessages: 2 });
    expect(out2).toContain("(8 новіших повідомлень пропущено)");
    expect(out2).toContain("→ [<@U>");
  });
  it("shows a placeholder for an empty text (file-only message)", () => {
    const out = renderLinkedThread({ channelId: "C1", messages: [{ ts: "1.000000", user: "U", text: "" }], linkedTs: "1.000000" });
    expect(out).toContain("(без тексту)");
  });
});

describe("formatLinkBlocks", () => {
  it("returns null for nothing and one block per link otherwise, errors inline", () => {
    expect(formatLinkBlocks([])).toBeNull();
    const out = formatLinkBlocks([
      { url: MSG, rendered: "R1" },
      { url: REPLY, error: "бот не в цьому каналі" },
    ])!;
    expect(out.startsWith("Вміст посилань зі Slack, згаданих у запиті:")).toBe(true);
    expect(out).toContain(`Посилання: ${MSG}\nR1`);
    expect(out).toContain(`Посилання: ${REPLY}\n(не вдалося прочитати: бот не в цьому каналі)`);
  });
});
