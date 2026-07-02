import { describe, it, expect } from "vitest";
import { classifyDmReply } from "./agentDm";

describe("classifyDmReply", () => {
  it.each(["так", "Так", "ок", "ok", "+", "👍", " так "])("confirm: %s", (t) =>
    expect(classifyDmReply(t)).toBe("confirm"));
  it.each(["ні", "Ні", "скасуй", "ні, скасуй", "👎"])("cancel: %s", (t) =>
    expect(classifyDmReply(t)).toBe("cancel"));
  it.each(["створи задачу для Тараса", "а що по jira?", ""])("other: %s", (t) =>
    expect(classifyDmReply(t)).toBe("other"));
});
