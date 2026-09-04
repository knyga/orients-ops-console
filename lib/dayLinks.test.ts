// lib/dayLinks.test.ts
import { describe, expect, it } from "vitest";
import { collectDayNodes, latestTextForTs, planRelink, renderLinks, summaryChunkFor, type DayNodes, type OutboundRowLike } from "./dayLinks";
import { LINKS_MARKER, withLinksRegion } from "./linksRegion";
import { contentRev } from "./outboundKeys";
import type { PublishedLog } from "./published";
import type { NotifiedLog } from "./bonusNotified";

const url = (ts: string) => `https://w.slack.com/archives/C1/p${ts.replace(".", "")}`;
const row = (o: Partial<OutboundRowLike> & { key: string }): OutboundRowLike => ({
  feature: "x", status: "sent", ts: "9.9", text: "", channel: "field-qa", sentAt: null, ...o,
});

const published: PublishedLog = {
  "2026-09-03#100.1": { date: "2026-09-03", reportTs: "100.1", channel: "field-qa", text: "✅ v1", ts: "200.1", postedAt: "" },
  "2026-09-03#100.2": { date: "2026-09-03", reportTs: "100.2", channel: "field-qa", text: "⚠️ v2", ts: "200.2", postedAt: "" },
  "2026-09-02#100.0": { date: "2026-09-02", reportTs: "100.0", channel: "field-qa", text: "✅ other day", ts: "200.0", postedAt: "" },
};
const notified: NotifiedLog = {
  "2026-09-03#100.1": { date: "2026-09-03", reportTs: "100.1", threadTs: "300.1", dms: [] },
};
const outbound: OutboundRowLike[] = [
  row({ key: "drone-reminder:2026-09-03", feature: "drone-reminder", ts: "50.0", text: "🛸 Звіт по дронах за 03.09\n<@U1> — …" }),
  row({ key: "bonus-thread:2026-09-03#100.1", feature: "bonus", ts: "300.1", text: "💰 Бонуси за 2026-09-03 (попередньо): разом 700 грн" }),
  row({ key: "links-zvit:100.2", feature: "links", ts: "400.2", text: `${LINKS_MARKER}<${url("200.2")}|Вердикт>` }),
  row({ key: "field-summary:2026-09:2026-09-30:field-qa:anchor", feature: "field-summary", ts: "500.0", text: "*Польові дні — вересень 2026*" }),
  row({ key: "field-summary:2026-09:2026-09-30:field-qa:t1", feature: "field-summary", ts: "500.1", text: "*02.09 ср* · екіпаж …\n*03.09 чт* · виїзд 1/2 · …\n*03.09 чт* · виїзд 2/2 · …" }),
];

describe("collectDayNodes", () => {
  it("gathers the day's reminder, per-report verdict/bonus/zvit-reply nodes and the summary chunk", () => {
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified, outbound });
    expect(n.reminderTs).toBe("50.0");
    expect(n.reports.map((r) => r.reportTs)).toEqual(["100.1", "100.2"]); // ordered by Звіт ts
    expect(n.reports[0]).toMatchObject({ verdictTs: "200.1", verdictText: "✅ v1", bonusTs: "300.1", bonusText: expect.stringContaining("Бонуси") });
    expect(n.reports[0].zvitReplyTs).toBeUndefined();
    expect(n.reports[1]).toMatchObject({ verdictTs: "200.2", zvitReplyTs: "400.2" });
    expect(n.reports[1].bonusTs).toBeUndefined();
    expect(n.summaryTs).toBe("500.1");
  });
  it("ignores other days, other channels, and non-sent rows", () => {
    const n = collectDayNodes({
      date: "2026-09-02", channel: "field-qa", published, notified,
      outbound: [row({ key: "drone-reminder:2026-09-02", feature: "drone-reminder", status: "failed", ts: null })],
    });
    expect(n.reminderTs).toBeUndefined();
    expect(n.reports.map((r) => r.reportTs)).toEqual(["100.0"]);
    expect(collectDayNodes({ date: "2026-09-02", channel: "orients-ops-console-test", published, notified, outbound }).reports).toEqual([]);
  });
  it("bonusTs without a bonus-thread row leaves bonusText undefined (never a body-wiping edit)", () => {
    const localNotified: NotifiedLog = { "2026-09-03#100.1": { date: "2026-09-03", reportTs: "100.1", threadTs: "300.1", dms: [] } };
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified: localNotified, outbound: [] });
    expect(n.reports[0].bonusTs).toBe("300.1");
    expect(n.reports[0].bonusText).toBeUndefined();
  });
  it("an overridden published row still yields a report node (override no longer special-cased here)", () => {
    const overriddenPublished: PublishedLog = {
      ...published,
      "2026-09-03#100.1": { ...published["2026-09-03#100.1"], override: { decision: "rejected", by: "X", ackedAt: "2026-09-03T10:00:00Z" } },
    };
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published: overriddenPublished, notified, outbound });
    const r1 = n.reports.find((r) => r.reportTs === "100.1")!;
    expect(r1.verdictTs).toBe("200.1");
    expect(r1.verdictText).toBe("✅ v1"); // no live-edit row shares this ts in this fixture, so falls back to the entry text
  });
  it("ignores a links-zvit or bonus-thread row posted to a foreign channel", () => {
    const foreignOutbound: OutboundRowLike[] = [
      row({ key: "bonus-thread:2026-09-03#100.1", feature: "bonus", ts: "300.1", text: "💰 foreign", channel: "orients-ops-console-test" }),
      row({ key: "links-zvit:100.1", feature: "links", ts: "400.1", text: "🔗 foreign", channel: "orients-ops-console-test" }),
    ];
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified, outbound: foreignOutbound });
    const r1 = n.reports.find((r) => r.reportTs === "100.1")!;
    expect(r1.bonusTs).toBe("300.1"); // threadTs comes from `notified`, which carries no channel
    expect(r1.bonusText).toBeUndefined();
    expect(r1.zvitReplyTs).toBeUndefined();
    expect(r1.zvitReplyText).toBeUndefined();
  });
  it("uses the newest SENT row sharing a ts as the current text — a links edit row wins over the original reminder/bonus/zvit-reply post", () => {
    const withEdits: OutboundRowLike[] = [
      ...outbound,
      row({ key: "links-edit:reminder:2026-09-03:abc", feature: "links", ts: "50.0", text: "🛸 Звіт по дронах за 03.09\n<@U1> — …\n🔗 <url|Звіт>", sentAt: "2026-09-03T09:00:00Z" }),
      row({ key: "links-edit:bonus:2026-09-03#100.1:abc", feature: "links", ts: "300.1", text: "💰 Бонуси за 2026-09-03 (попередньо): разом 700 грн\n🔗 <url|Звіт>", sentAt: "2026-09-03T09:00:00Z" }),
      row({ key: "links-zvit-edit:100.2:abc", feature: "links", ts: "400.2", text: "🔗 <url|Вердикт> · <url|Дрони>", sentAt: "2026-09-03T09:00:00Z" }),
    ];
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified, outbound: withEdits });
    expect(n.reminderText).toBe("🛸 Звіт по дронах за 03.09\n<@U1> — …\n🔗 <url|Звіт>");
    expect(n.reports[0].bonusText).toBe("💰 Бонуси за 2026-09-03 (попередньо): разом 700 грн\n🔗 <url|Звіт>");
    expect(n.reports[1].zvitReplyText).toBe("🔗 <url|Вердикт> · <url|Дрони>");
  });
  it("verdictText prefers a later sent row sharing the verdict ts (e.g. an approval-override edit) over the published entry's stored text", () => {
    const struck = "~✅ v1~\n⛔ Оновлено → відхилено, X: причина";
    const withApprovalEdit: OutboundRowLike[] = [
      ...outbound,
      row({ key: "approval-edit:2026-09-03#100.1:rejected", feature: "approval", ts: "200.1", text: struck, sentAt: "2026-09-03T09:00:00Z" }),
    ];
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified, outbound: withApprovalEdit });
    expect(n.reports[0].verdictText).toBe(struck);
  });
  it("ignores an edit row sharing a ts but posted to a foreign channel when picking the current text", () => {
    const foreignEdit: OutboundRowLike[] = [
      ...outbound,
      row({ key: "links-edit:reminder:2026-09-03:abc", feature: "links", ts: "50.0", text: "🔗 foreign edit", channel: "orients-ops-console-test", sentAt: "2026-09-03T09:00:00Z" }),
    ];
    const n = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published, notified, outbound: foreignEdit });
    expect(n.reminderText).toBe("🛸 Звіт по дронах за 03.09\n<@U1> — …");
  });
});

describe("latestTextForTs", () => {
  it("picks the newest sent row by sentAt sharing the ts, ignoring non-sent rows and other ts", () => {
    const rows: OutboundRowLike[] = [
      row({ key: "a", ts: "1.1", text: "post", sentAt: "2026-09-01T00:00:00Z" }),
      row({ key: "b", ts: "1.1", text: "edit", sentAt: "2026-09-02T00:00:00Z" }),
      row({ key: "c", ts: "1.1", text: "not-sent", status: "failed", sentAt: "2026-09-03T00:00:00Z" }),
      row({ key: "d", ts: "9.9", text: "other-ts", sentAt: "2026-09-04T00:00:00Z" }),
    ];
    expect(latestTextForTs(rows, "1.1")).toBe("edit");
  });
  it("treats a null sentAt as oldest", () => {
    const rows: OutboundRowLike[] = [
      row({ key: "a", ts: "1.1", text: "post", sentAt: null }),
      row({ key: "b", ts: "1.1", text: "edit", sentAt: "2026-09-01T00:00:00Z" }),
    ];
    expect(latestTextForTs(rows, "1.1")).toBe("edit");
  });
  it("returns undefined when no sent row shares the ts", () => {
    expect(latestTextForTs([row({ key: "a", ts: "1.1", text: "x" })], "2.2")).toBeUndefined();
  });
});

describe("summaryChunkFor", () => {
  const chunks = (texts: string[]) => texts.map((t, i) => row({ key: `field-summary:2026-09:d:field-qa:t${i + 1}`, feature: "field-summary", ts: `500.${i + 1}`, text: t }));
  it("returns the single chunk whose line starts with the day label", () => {
    expect(summaryChunkFor("2026-09-03", chunks(["*02.09 ср* · a", "*03.09 чт* · b"]), "field-qa")).toBe("500.2");
  });
  it("returns null when no chunk or more than one chunk carries the day", () => {
    expect(summaryChunkFor("2026-09-04", chunks(["*02.09 ср* · a"]), "field-qa")).toBeNull();
    expect(summaryChunkFor("2026-09-03", chunks(["*03.09 чт* · виїзд 1/2", "*03.09 чт* · виїзд 2/2"]), "field-qa")).toBeNull();
  });
  it("never matches the anchor or a foreign channel", () => {
    const rows = [row({ key: "field-summary:2026-09:d:field-qa:anchor", feature: "field-summary", ts: "1.0", text: "*03.09 чт*" }),
      row({ key: "field-summary:2026-09:d:t:t1", feature: "field-summary", ts: "1.1", text: "*03.09 чт*", channel: "orients-ops-console-test" })];
    expect(summaryChunkFor("2026-09-03", rows, "field-qa")).toBeNull();
  });
});

describe("renderLinks", () => {
  const nodes: DayNodes = {
    date: "2026-09-03", reminderTs: "50.0", summaryTs: "500.1",
    reports: [
      { reportTs: "100.1", verdictTs: "200.1", bonusTs: "300.1" },
      { reportTs: "100.2", verdictTs: "200.2" },
    ],
  };
  it("reminder (day-level) lists per-report items with ordinals, then the summary", () => {
    expect(renderLinks({ kind: "reminder", date: "2026-09-03" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт 1/2> · <${url("100.2")}|Звіт 2/2> · <${url("200.1")}|Вердикт 1/2> · <${url("200.2")}|Вердикт 2/2> · <${url("300.1")}|Бонуси 1/2> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("verdict links its own Звіт · Дрони · Бонуси · Підсумок, never itself", () => {
    expect(renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт> · <${url("50.0")}|Дрони> · <${url("300.1")}|Бонуси> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("bonus omits itself AND the verdict it is threaded under", () => {
    expect(renderLinks({ kind: "bonus", date: "2026-09-03", reportTs: "100.1" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт> · <${url("50.0")}|Дрони> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("zvit reply omits the Звіт", () => {
    expect(renderLinks({ kind: "zvit", reportTs: "100.2" }, nodes, url)).toBe(
      `${LINKS_MARKER}<${url("200.2")}|Вердикт> · <${url("50.0")}|Дрони> · <${url("500.1")}|Підсумок>`,
    );
  });
  it("single-report day has no ordinals; nothing to link → null", () => {
    const single: DayNodes = { date: "2026-09-03", reports: [{ reportTs: "100.1", verdictTs: "200.1" }] };
    expect(renderLinks({ kind: "reminder", date: "2026-09-03" }, single, url)).toBe(
      `${LINKS_MARKER}<${url("100.1")}|Звіт> · <${url("200.1")}|Вердикт>`,
    );
    expect(renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, single, url)).toBe(`${LINKS_MARKER}<${url("100.1")}|Звіт>`);
    expect(renderLinks({ kind: "zvit", reportTs: "100.1" }, { date: "2026-09-03", reports: [{ reportTs: "100.1" }] }, url)).toBeNull();
  });
});

describe("planRelink", () => {
  const base: DayNodes = {
    date: "2026-09-03", reminderTs: "50.0", reminderText: "🛸 Звіт по дронах за 03.09\n<@U1> — …",
    reports: [{ reportTs: "100.1", verdictTs: "200.1", verdictText: "✅ v1\n👥 У полі: <@U1>." }],
  };
  it("emits an edit per target whose 🔗 line differs, keyed by content-rev, plus the Звіт reply post", () => {
    const edits = planRelink(base, { permalink: url, zvitReply: true });
    const reminderLine = renderLinks({ kind: "reminder", date: "2026-09-03" }, base, url)!;
    const verdictLine = renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, base, url)!;
    const zvitLine = renderLinks({ kind: "zvit", reportTs: "100.1" }, base, url)!;
    expect(edits).toEqual([
      { target: { kind: "reminder", date: "2026-09-03" }, op: "edit", ts: "50.0", threadTs: null,
        newText: withLinksRegion(base.reminderText!, reminderLine), key: `links-edit:reminder:2026-09-03:${contentRev(reminderLine)}` },
      { target: { kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, op: "edit", ts: "200.1", threadTs: null,
        newText: withLinksRegion(base.reports[0].verdictText!, verdictLine), key: `links-edit:verdict:2026-09-03#100.1:${contentRev(verdictLine)}` },
      { target: { kind: "zvit", reportTs: "100.1" }, op: "post", ts: null, threadTs: "100.1", newText: zvitLine, key: "links-zvit:100.1" },
    ]);
  });
  it("is a no-op when every message already carries the current line", () => {
    const reminderLine = renderLinks({ kind: "reminder", date: "2026-09-03" }, base, url)!;
    const verdictLine = renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, base, url)!;
    const zvitLine = renderLinks({ kind: "zvit", reportTs: "100.1" }, base, url)!;
    const current: DayNodes = {
      ...base, reminderText: withLinksRegion(base.reminderText!, reminderLine),
      reports: [{ ...base.reports[0], verdictText: withLinksRegion(base.reports[0].verdictText!, verdictLine), zvitReplyTs: "400.1", zvitReplyText: zvitLine }],
    };
    expect(planRelink(current, { permalink: url, zvitReply: true })).toEqual([]);
  });
  it("regression: no reminder edit when the current 🔗 line lives in a links EDIT row rather than the reminder's original post row", () => {
    const reminderLine = renderLinks({ kind: "reminder", date: "2026-09-03" }, base, url)!;
    const localPublished: PublishedLog = {
      "2026-09-03#100.1": { date: "2026-09-03", reportTs: "100.1", channel: "field-qa", text: base.reports[0].verdictText!, ts: "200.1", postedAt: "" },
    };
    const localOutbound: OutboundRowLike[] = [
      row({ key: "drone-reminder:2026-09-03", feature: "drone-reminder", ts: "50.0", text: base.reminderText!, sentAt: "2026-09-03T06:00:00Z" }),
      row({ key: "links-edit:reminder:2026-09-03:abc", feature: "links", ts: "50.0", text: withLinksRegion(base.reminderText!, reminderLine), sentAt: "2026-09-03T09:00:00Z" }),
    ];
    const nodes = collectDayNodes({ date: "2026-09-03", channel: "field-qa", published: localPublished, notified: {}, outbound: localOutbound });
    const edits = planRelink(nodes, { permalink: url, zvitReply: false });
    expect(edits.some((e) => e.target.kind === "reminder")).toBe(false);
  });
  it("edits a stale Звіт reply under its own edit key", () => {
    const stale: DayNodes = { ...base, reports: [{ ...base.reports[0], zvitReplyTs: "400.1", zvitReplyText: `${LINKS_MARKER}<old|Вердикт>` }] };
    const zvitLine = renderLinks({ kind: "zvit", reportTs: "100.1" }, stale, url)!;
    const e = planRelink(stale, { permalink: url, zvitReply: true }).find((x) => x.target.kind === "zvit")!;
    expect(e).toEqual({ target: { kind: "zvit", reportTs: "100.1" }, op: "edit", ts: "400.1", threadTs: null, newText: zvitLine, key: `links-zvit-edit:100.1:${contentRev(zvitLine)}` });
  });
  it("zvitReply:false suppresses the POST but still edits an existing reply", () => {
    expect(planRelink(base, { permalink: url, zvitReply: false }).some((e) => e.op === "post")).toBe(false);
    const stale: DayNodes = { ...base, reports: [{ ...base.reports[0], zvitReplyTs: "400.1", zvitReplyText: "🔗 <old|Вердикт>" }] };
    expect(planRelink(stale, { permalink: url, zvitReply: false }).some((e) => e.target.kind === "zvit" && e.op === "edit")).toBe(true);
  });
  it("never posts a Звіт reply for a report without a verdict, and skips targets whose text is unknown", () => {
    const noVerdict: DayNodes = { date: "2026-09-03", reminderTs: "50.0", reminderText: "r", reports: [{ reportTs: "100.1" }] };
    expect(planRelink(noVerdict, { permalink: url, zvitReply: true }).map((e) => e.target.kind)).toEqual(["reminder"]);
    const unknownText: DayNodes = { date: "2026-09-03", reminderTs: "50.0", reports: [{ reportTs: "100.1", verdictTs: "200.1", verdictText: "v" }] };
    expect(planRelink(unknownText, { permalink: url, zvitReply: false }).map((e) => e.target.kind)).toEqual(["verdict"]);
  });
  it("emits a bonus edit that preserves the original 💰 body, never wiping it down to the bare link line", () => {
    const withBonus: DayNodes = { ...base, reports: [{ ...base.reports[0], bonusTs: "300.1", bonusText: "💰 Бонуси за 2026-09-03 (попередньо): разом 700 грн" }] };
    const bonusLine = renderLinks({ kind: "bonus", date: "2026-09-03", reportTs: "100.1" }, withBonus, url)!;
    const e = planRelink(withBonus, { permalink: url, zvitReply: false }).find((x) => x.target.kind === "bonus")!;
    expect(e).toBeDefined();
    expect(e.key).toBe(`links-edit:bonus:2026-09-03#100.1:${contentRev(bonusLine)}`);
    expect(e.newText.startsWith("💰 Бонуси за 2026-09-03 (попередньо): разом 700 грн")).toBe(true);
    expect(e.newText).not.toBe(bonusLine); // must never collapse to the bare 🔗 line
  });
  it("never edits a bonus node whose text is undefined or empty (unknown current text is skipped, not blind-edited)", () => {
    const undefinedBonus: DayNodes = { ...base, reports: [{ ...base.reports[0], bonusTs: "300.1" }] };
    expect(planRelink(undefinedBonus, { permalink: url, zvitReply: false }).some((e) => e.target.kind === "bonus")).toBe(false);
    const emptyBonus: DayNodes = { ...base, reports: [{ ...base.reports[0], bonusTs: "300.1", bonusText: "" }] };
    expect(planRelink(emptyBonus, { permalink: url, zvitReply: false }).some((e) => e.target.kind === "bonus")).toBe(false);
  });
  it("edits an approver-overridden verdict's live (struck) text when its 🔗 line is stale, preserving the strike — plus the reminder edit and the Звіт reply post", () => {
    const struckText = "~✅ v1~\n⛔ Оновлено → відхилено, X: причина"; // no 🔗 line yet — the "live" text collectDayNodes would hand us
    const overridden: DayNodes = { ...base, reports: [{ ...base.reports[0], verdictText: struckText }] };
    const edits = planRelink(overridden, { permalink: url, zvitReply: true });
    const verdictEdit = edits.find((e) => e.target.kind === "verdict")!;
    expect(verdictEdit).toBeDefined();
    expect(verdictEdit.newText.startsWith(struckText)).toBe(true); // strike survives
    expect(verdictEdit.newText).toContain("🔗 ");
    expect(edits.some((e) => e.target.kind === "reminder")).toBe(true);
    expect(edits.some((e) => e.target.kind === "zvit" && e.op === "post")).toBe(true);
  });
  it("no verdict edit when the overridden verdict's live text already carries the current 🔗 line", () => {
    const struckText = "~✅ v1~\n⛔ Оновлено → відхилено, X: причина";
    const verdictLine = renderLinks({ kind: "verdict", date: "2026-09-03", reportTs: "100.1" }, base, url)!;
    const current: DayNodes = { ...base, reports: [{ ...base.reports[0], verdictText: withLinksRegion(struckText, verdictLine) }] };
    const edits = planRelink(current, { permalink: url, zvitReply: false });
    expect(edits.some((e) => e.target.kind === "verdict")).toBe(false);
  });
});
