import { describe, expect, it } from "vitest";
import { parseMrkdwnLine } from "./mrkdwnLite";

describe("parseMrkdwnLine", () => {
  it("splits Slack mrkdwn into text / bold / link segments", () => {
    expect(parseMrkdwnLine("*01.08 сб* · екіпаж Влад · <https://x/p1|вердикт> · <https://x/p2|звіт>")).toEqual([
      { kind: "bold", text: "01.08 сб" },
      { kind: "text", text: " · екіпаж Влад · " },
      { kind: "link", text: "вердикт", href: "https://x/p1" },
      { kind: "text", text: " · " },
      { kind: "link", text: "звіт", href: "https://x/p2" },
    ]);
  });
  it("renders a channel mention as text and leaves plain lines untouched", () => {
    expect(parseMrkdwnLine("у <#C08GY2NKF9D> (анкор)")).toEqual([
      { kind: "text", text: "у " },
      { kind: "text", text: "#C08GY2NKF9D" },
      { kind: "text", text: " (анкор)" },
    ]);
    expect(parseMrkdwnLine("Деталі по днях — у треді 👇")).toEqual([{ kind: "text", text: "Деталі по днях — у треді 👇" }]);
  });
});
