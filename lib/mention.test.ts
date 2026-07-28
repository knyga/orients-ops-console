import { describe, it, expect, vi } from "vitest";
import { mentionize, mention, dementionText } from "./mention";
import { PEOPLE } from "./people";

const taras = PEOPLE.find((p) => p.name === "Taras Panasyuk")!; // slackId U09LT4HM9PY, rosterInitial "Т"
const serhiy = PEOPLE.find((p) => p.name === "Serhiy Shainyuk")!; // slackId, rosterInitial "Сер"

describe("mentionize", () => {
  it("resolves the roster first-name form", () => {
    expect(mentionize("Тарас")).toBe(`<@${taras.slackId}>`);
  });
  it("resolves the canonical name form", () => {
    expect(mentionize("Taras Panasyuk")).toBe(`<@${taras.slackId}>`);
  });
  it("resolves an alias form", () => {
    expect(mentionize("Влад")).toBe("<@U09UA5J6CHH>");
  });
  it("resolves the 'Сер' prefix roster name", () => {
    expect(mentionize("Сергій")).toBe(`<@${serhiy.slackId}>`);
  });
  it("is case- and whitespace-insensitive", () => {
    expect(mentionize("  тарас ")).toBe(`<@${taras.slackId}>`);
  });
  it("leaves an unknown person-like name plain and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mentionize("Незнайомець")).toBe("Незнайомець");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
  it("leaves a drone category plain without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mentionize("15ка")).toBe("15ка");
    expect(mentionize("інші")).toBe("інші");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("mention", () => {
  it("mentions a person with a slackId", () => {
    expect(mention(taras)).toBe(`<@${taras.slackId}>`);
  });
  it("falls back to the name when no slackId", () => {
    expect(mention({ name: "Nobody", role: "x" })).toBe("Nobody");
  });
});

describe("dementionText", () => {
  it("rewrites a known id back to the canonical name", () => {
    expect(dementionText(`👥 У полі: <@${taras.slackId}>, <@${serhiy.slackId}>.`))
      .toBe("👥 У полі: Taras Panasyuk, Serhiy Shainyuk.");
  });
  it("leaves an unknown id token intact", () => {
    expect(dementionText("<@U000UNKNOWN>")).toBe("<@U000UNKNOWN>");
  });
});
