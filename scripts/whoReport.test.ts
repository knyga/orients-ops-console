// scripts/whoReport.test.ts
import { describe, it, expect } from "vitest";
import { parseArgs, resolvePeriod, formatTable, formatUnlinkedTable } from "./whoReport";
import type { PersonView } from "../lib/who";

describe("parseArgs", () => {
  it("parses person, bounds, format and unlinked flag", () => {
    expect(parseArgs(["--person", "bohdan", "--start", "2026-06-01", "--end", "2026-06-30", "--format", "table"]))
      .toEqual({ person: "bohdan", start: "2026-06-01", end: "2026-06-30", format: "table", unlinked: false });
    expect(parseArgs(["--unlinked"]).unlinked).toBe(true);
  });
});

describe("resolvePeriod", () => {
  it("uses explicit bounds when given", () => {
    expect(resolvePeriod({ start: "2026-05-02", end: "2026-05-20", unlinked: false }, "2026-06-15"))
      .toEqual({ start: "2026-05-02", end: "2026-05-20" });
  });
  it("defaults to the current Kyiv calendar month", () => {
    expect(resolvePeriod({ unlinked: false }, "2026-06-15"))
      .toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });
});

describe("formatTable", () => {
  it("renders the person header, timeline rows and present summary blocks", () => {
    const view: PersonView = {
      person: { name: "Oleksandr K", role: "CEO/CTO", slackId: "U1" },
      period: { start: "2026-06-01", end: "2026-06-30" },
      timeline: [{ ts: "1", isoTime: "2026-06-03T09:12:00.000Z", channel: "datasets", text: "dataset за 02.06", permalink: "p" }],
      summary: { jira: { issueKeys: ["ORI-1"], count: 1, points: 3 } },
    };
    const out = formatTable(view);
    expect(out).toContain("Oleksandr K");
    expect(out).toContain("datasets");
    expect(out).toContain("dataset за 02.06");
    expect(out).toContain("jira");
    expect(out).not.toContain("github"); // absent block not printed
  });
});

describe("formatUnlinkedTable", () => {
  it("lists each namespace's unlinked identities", () => {
    const out = formatUnlinkedTable({ slack: ["U_x"], jira: [], github: ["petro-x"], roster: ["Невідомий"] });
    expect(out).toContain("U_x");
    expect(out).toContain("petro-x");
    expect(out).toContain("Невідомий");
  });
});
