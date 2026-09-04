// scripts/fieldLinksReport.test.ts
import { describe, expect, it } from "vitest";
import { parseLinksArgs, renderLinksTable, resolveZvitReply } from "./fieldLinksReport";

describe("parseLinksArgs", () => {
  it("parses flags; zvit-reply defaults to null", () => {
    expect(parseLinksArgs(["--start", "2026-09-01", "--end", "2026-09-04", "--publish", "--channel", "field-qa", "--format", "table"]))
      .toEqual({ start: "2026-09-01", end: "2026-09-04", publish: true, channel: "field-qa", zvitReply: null, format: "table" });
    expect(parseLinksArgs(["--zvit-reply"]).zvitReply).toBe(true);
    expect(parseLinksArgs(["--no-zvit-reply"]).zvitReply).toBe(false);
  });
  it("rejects unknown flags", () => {
    expect(() => parseLinksArgs(["--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("resolveZvitReply", () => {
  it("explicit flag wins; otherwise only periods ending within 14 days of today post new Звіт replies", () => {
    expect(resolveZvitReply(true, { start: "2026-07-01", end: "2026-07-31" }, "2026-09-04")).toBe(true);
    expect(resolveZvitReply(false, { start: "2026-09-01", end: "2026-09-04" }, "2026-09-04")).toBe(false);
    expect(resolveZvitReply(null, { start: "2026-09-01", end: "2026-09-04" }, "2026-09-04")).toBe(true);
    expect(resolveZvitReply(null, { start: "2026-07-01", end: "2026-07-31" }, "2026-09-04")).toBe(false);
  });
});

describe("renderLinksTable", () => {
  it("one row per day with node markers and the planned edit count", () => {
    const out = renderLinksTable([{
      date: "2026-09-03",
      nodes: { date: "2026-09-03", reminderTs: "50.0", reports: [{ reportTs: "100.1", verdictTs: "200.1" }], summaryTs: undefined },
      edits: [{ target: { kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, op: "edit", ts: "200.1", threadTs: null, newText: "x", key: "links-edit:verdict:2026-09-03#100.1:abc" }],
    }]);
    expect(out).toContain("2026-09-03");
    expect(out).toContain("дрони ✓");
    expect(out).toContain("звіт 1  вердикт ✓  бонуси –  🔗-звіт –");
    expect(out).toContain("edits: 1");
    expect(out).toContain("edit  links-edit:verdict:2026-09-03#100.1:abc");
  });
});
