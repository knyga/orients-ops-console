import { describe, expect, it } from "vitest";
import { LINKS_MARKER, splitLinksRegion, withLinksRegion } from "./linksRegion";

const body = "✅ 18.06 — прийнято (…).\n👥 У полі: <@U1>, <@U2>.\n🛸 Дрони: Влад 3; разом 3";
const line = `${LINKS_MARKER}<https://x/p1|Звіт> · <https://x/p2|Дрони>`;

describe("linksRegion", () => {
  it("appends a 🔗 line as the last line", () => {
    expect(withLinksRegion(body, line)).toBe(`${body}\n${line}`);
  });
  it("replaces an existing 🔗 line instead of stacking", () => {
    const other = `${LINKS_MARKER}<https://x/p9|Бонуси>`;
    expect(withLinksRegion(`${body}\n${line}`, other)).toBe(`${body}\n${other}`);
  });
  it("null strips the region and leaves the rest byte-identical", () => {
    expect(withLinksRegion(`${body}\n${line}`, null)).toBe(body);
    expect(withLinksRegion(body, null)).toBe(body);
  });
  it("split peels exactly one trailing 🔗 line", () => {
    expect(splitLinksRegion(`${body}\n${line}`)).toEqual({ rest: body, linksLine: line });
    expect(splitLinksRegion(body)).toEqual({ rest: body, linksLine: null });
  });
  it("split ignores a 🔗 line that is not the last line", () => {
    const text = `${line}\n${body}`;
    expect(splitLinksRegion(text)).toEqual({ rest: text, linksLine: null });
  });
  it("split handles a single-line message that is only a 🔗 line", () => {
    expect(splitLinksRegion(line)).toEqual({ rest: "", linksLine: line });
  });
});
