import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyProposal } from "./proposalExecutor";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "ATP",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
};
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

vi.mock("@/lib/googleCalendar", () => ({
  createCalendarEvent: vi.fn(async () => ({
    eventId: "ev1",
    htmlLink: "https://calendar.google.com/event?eid=ev1",
    meetLink: "https://meet.google.com/abc-defg-hij",
  })),
}));

const mocks = vi.hoisted(() => ({
  upsertLossRecord: vi.fn(),
  readPublished: vi.fn(),
  postMessage: vi.fn(),
  findSentByTs: vi.fn(),
  fillSprintPlan: vi.fn(),
  postFieldSummary: vi.fn(),
}));
vi.mock("@/lib/fieldSummaryPost", () => ({ postFieldSummary: mocks.postFieldSummary }));
vi.mock("@/lib/lossStore", () => ({ upsertLossRecord: mocks.upsertLossRecord }));
vi.mock("@/lib/published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readPublished: mocks.readPublished };
});
vi.mock("@/lib/slack", () => ({ postMessage: mocks.postMessage }));
vi.mock("@/lib/outbound", () => ({ findSentByTs: mocks.findSentByTs }));
vi.mock("@/lib/runSprint", () => ({ fillSprintPlan: mocks.fillSprintPlan }));

beforeEach(() => {
  mocks.upsertLossRecord.mockReset().mockResolvedValue(true);
  mocks.readPublished.mockReset().mockResolvedValue({});
  mocks.postMessage.mockReset().mockResolvedValue("1782900000.000200");
  mocks.findSentByTs.mockReset().mockResolvedValue([]);
  mocks.fillSprintPlan.mockReset().mockResolvedValue({ slug: "ATP-49", sprintName: "ATP 49", count: 12 });
  mocks.postFieldSummary.mockReset().mockResolvedValue({ anchorTs: "1788400000.000100", replies: 4, days: 31 });
});

describe("applyProposal", () => {
  it("jira_create POSTs project + no assignee when accountId null, returns UA line with key+url", async () => {
    const f = mockFetch(201, { key: "MRLAB-3" });
    const out = await applyProposal("jira_create", {
      projectKey: "MRLAB",
      summary: "S",
      description: "Виконавець: Taras Panasyuk",
      assigneeAccountId: null,
    });
    expect(out).toContain("MRLAB-3");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.fields.project).toEqual({ key: "MRLAB" });
    expect("assignee" in body.fields).toBe(false);
  });

  it("jira_create with nextSprint creates the issue THEN moves it into the sprint", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/rest/api/3/issue")) return new Response(JSON.stringify({ key: "ATP-9" }), { status: 201 });
      return new Response(null, { status: 204 });
    });
    const out = await applyProposal("jira_create", {
      projectKey: "ATP",
      summary: "S",
      description: "",
      assigneeAccountId: null,
      nextSprint: { boardId: 1, sprintId: 1256, sprintName: "ATP 42" },
    });
    expect(out).toContain("ATP-9");
    expect(out).toContain("ATP 42");
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/rest/agile/1.0/sprint/1256/issue"))).toBe(true);
  });

  it("jira_create still reports the created key when the sprint move fails afterwards", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/rest/api/3/issue")) return new Response(JSON.stringify({ key: "ATP-9" }), { status: 201 });
      return new Response("boom", { status: 500 });
    });
    const out = await applyProposal("jira_create", {
      projectKey: "ATP",
      summary: "S",
      description: "",
      assigneeAccountId: null,
      nextSprint: { boardId: 1, sprintId: 1256, sprintName: "ATP 42" },
    });
    expect(out).toContain("ATP-9");
    expect(out).toContain("не вдалося");
  });

  it("jira_comment calls the comment endpoint", async () => {
    const f = mockFetch(201, {});
    const out = await applyProposal("jira_comment", { key: "ATP-7", body: "hi" });
    expect(out).toContain("ATP-7");
    expect(String(f.mock.calls[0][0])).toContain("/rest/api/3/issue/ATP-7/comment");
  });

  it("calendar_create_event passes the serialized params to createCalendarEvent and returns the UA confirmation", async () => {
    const { createCalendarEvent } = await import("@/lib/googleCalendar");
    const out = await applyProposal("calendar_create_event", {
      title: "Синк",
      description: "",
      startIso: "2026-07-08T15:00",
      endIso: "2026-07-08T15:30",
      attendeeEmails: ["a@x.com"],
      requestId: "r-1",
    });
    expect(out).toContain("✅");
    expect(out).toContain("https://meet.google.com/abc-defg-hij");
    expect(vi.mocked(createCalendarEvent).mock.calls[0][0]).toMatchObject({
      title: "Синк",
      attendeeEmails: ["a@x.com"],
      requestId: "r-1",
    });
  });

  it("calendar_create_event rejects params missing a required field", async () => {
    await expect(
      applyProposal("calendar_create_event", { title: "X", endIso: "2026-07-08T15:30" }),
    ).rejects.toThrow(/startIso/);
  });

  it("calendar_create_event rejects missing/empty attendeeEmails instead of defaulting to []", async () => {
    const base = {
      title: "Синк",
      startIso: "2026-07-08T15:00",
      endIso: "2026-07-08T15:30",
      requestId: "r-1",
    };
    await expect(applyProposal("calendar_create_event", base)).rejects.toThrow(/attendeeEmails/);
    await expect(
      applyProposal("calendar_create_event", { ...base, attendeeEmails: [] }),
    ).rejects.toThrow(/attendeeEmails/);
  });

  it("rejects an unknown kind", async () => {
    await expect(applyProposal("nope" as never, {})).rejects.toThrow(/Unknown proposal kind/);
  });
});

describe("applyProposal jira_move_to_sprint", () => {
  it("moves the issue straight into a resolved sprint id", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const out = await applyProposal("jira_move_to_sprint", {
      key: "ATP-1714",
      boardId: 1,
      sprintId: 1223,
      sprintName: "ATP 41",
    });
    expect(out).toContain("ATP-1714");
    expect(out).toContain("ATP 41");
    expect(String(f.mock.calls[0][0])).toContain("/rest/agile/1.0/sprint/1223/issue");
  });

  it("re-resolves by name at apply time when sprintId is null (sprint created meanwhile)", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/board/1/sprint"))
        return new Response(JSON.stringify({ isLast: true, values: [{ id: 77, name: "ATP 41", state: "future" }] }));
      return new Response(null, { status: 204 });
    });
    const out = await applyProposal("jira_move_to_sprint", {
      key: "ATP-1714",
      boardId: 1,
      sprintId: null,
      sprintName: "ATP 41",
    });
    expect(out).toContain("ATP 41");
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/rest/agile/1.0/sprint/77/issue"))).toBe(true);
    // no create happened
    expect(urls.some((u) => /\/rest\/agile\/1\.0\/sprint(\?|$)/.test(u))).toBe(false);
  });

  it("creates the sprint first when it still does not exist, then moves the issue", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/board/1/sprint"))
        return new Response(JSON.stringify({ isLast: true, values: [] }));
      if (url.endsWith("/rest/agile/1.0/sprint") && init?.method === "POST")
        return new Response(JSON.stringify({ id: 88, name: "ATP 41", state: "future" }), { status: 201 });
      return new Response(null, { status: 204 });
    });
    const out = await applyProposal("jira_move_to_sprint", {
      key: "ATP-1714",
      boardId: 1,
      sprintId: null,
      sprintName: "ATP 41",
    });
    expect(out).toContain("ATP 41");
    expect(out).toContain("створено");
    const createCall = f.mock.calls.find((c) => String(c[0]).endsWith("/rest/agile/1.0/sprint"));
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: "ATP 41", originBoardId: 1 });
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/rest/agile/1.0/sprint/88/issue"))).toBe(true);
  });
});

describe("applyProposal field_loss_set", () => {
  it("field_loss_set found: writes the day-wide instruction row and acks in the published thread", async () => {
    mocks.readPublished.mockResolvedValue({
      "2026-07-06#111.222": { date: "2026-07-06", reportTs: "111.222", channel: "field-qa", text: "…", postedAt: "t", ts: "111.222" },
    });
    const result = await applyProposal("field_loss_set", { date: "2026-07-06", state: "found", note: "знайшли на полі", by: "Oleksandr K" });
    expect(mocks.upsertLossRecord).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-07-06", reportTs: "", lost: true, found: true, source: "instruction", updatedBy: "Oleksandr K" }),
    );
    expect(mocks.postMessage).toHaveBeenCalled(); // ack in the verdict thread
    expect(result).toContain("знято");
  });

  it("field_loss_set lost with no published entry: writes the row, skips the ack cleanly", async () => {
    mocks.readPublished.mockResolvedValue({});
    const result = await applyProposal("field_loss_set", { date: "2026-07-06", state: "lost", by: "Oleksandr K" });
    expect(mocks.upsertLossRecord).toHaveBeenCalledWith(expect.objectContaining({ found: false }));
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(result).toContain("втрачено");
  });

  it("field_loss_set rejects an invalid state", async () => {
    await expect(applyProposal("field_loss_set", { date: "2026-07-06", state: "maybe" })).rejects.toThrow(/state/);
  });
});

describe("applyProposal sprint_plan_build", () => {
  const PARAMS = {
    channelId: "C08GX9DE54P",
    anchorTs: "1782899951.295969",
    sprintId: 1487,
    sprintName: "ATP 49",
  };
  const pendingRow = { key: "sprint-plan-pending:general:2026-08-25", kind: "post" };

  it("fills a pending anchor via fillSprintPlan and reports the count", async () => {
    mocks.findSentByTs.mockResolvedValue([pendingRow]);
    const out = await applyProposal("sprint_plan_build", PARAMS);
    expect(mocks.fillSprintPlan).toHaveBeenCalledWith({
      channelId: "C08GX9DE54P",
      anchorTs: "1782899951.295969",
      sprintId: 1487,
      trigger: "webhook",
    });
    expect(out).toContain("ATP 49");
    expect(out).toContain("12 задач");
  });

  it("refuses a message that is not the pending-plan anchor, before any side effect", async () => {
    mocks.findSentByTs.mockResolvedValue([{ key: "verdict:2026-08:2026-08-25", kind: "post" }]);
    await expect(applyProposal("sprint_plan_build", PARAMS)).rejects.toThrow(/не є заглушкою/);
    expect(mocks.fillSprintPlan).not.toHaveBeenCalled();
  });

  it("allows a SAME-slug re-apply (the partial-failure retry path)", async () => {
    mocks.findSentByTs.mockResolvedValue([
      pendingRow,
      { key: "sprint-plan-filled:general:ATP-49", kind: "edit", status: "sent" },
    ]);
    await expect(applyProposal("sprint_plan_build", PARAMS)).resolves.toContain("ATP 49");
    expect(mocks.fillSprintPlan).toHaveBeenCalledTimes(1);
  });

  it("refuses to rewrite an anchor already filled (SENT) with a DIFFERENT sprint", async () => {
    mocks.findSentByTs.mockResolvedValue([
      pendingRow,
      { key: "sprint-plan-filled:general:ATP-48", kind: "edit", status: "sent" },
    ]);
    await expect(applyProposal("sprint_plan_build", PARAMS)).rejects.toThrow(/вже заповнено планом іншого спринту/);
    expect(mocks.fillSprintPlan).not.toHaveBeenCalled();
  });

  it("a different-slug fill row that never LANDED (pending) does not block a new fill", async () => {
    // ATP 48's fill died before the edit reached Slack: its pending row is a
    // stuck reservation, not evidence of a fill — ATP 49 must still be able in.
    mocks.findSentByTs.mockResolvedValue([
      pendingRow,
      { key: "sprint-plan-filled:general:ATP-48", kind: "edit", status: "pending" },
    ]);
    await expect(applyProposal("sprint_plan_build", PARAMS)).resolves.toContain("ATP 49");
    expect(mocks.fillSprintPlan).toHaveBeenCalledTimes(1);
  });
});

describe("applyProposal field_summary_post", () => {
  it("posts the summary into the channel (new anchor) and reports anchor + reply count in Ukrainian", async () => {
    const out = await applyProposal("field_summary_post", {
      channelId: "C08GY2NKF9D",
      threadTs: null,
      start: "2026-08-01",
      end: "2026-08-31",
    });
    expect(mocks.postFieldSummary).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C08GY2NKF9D", period: { start: "2026-08-01", end: "2026-08-31" }, threadTs: undefined, trigger: "webhook" }),
    );
    expect(out).toContain("31");
    expect(out).toContain("4");
    expect(out).toMatch(/треді/);
  });

  it("posts into an existing thread when threadTs is given", async () => {
    await applyProposal("field_summary_post", {
      channelId: "C08GY2NKF9D",
      threadTs: "1788400000.000100",
      start: "2026-08-01",
      end: "2026-08-31",
    });
    expect(mocks.postFieldSummary.mock.calls[0][0]).toMatchObject({ threadTs: "1788400000.000100" });
  });

  it("rejects a malformed period before posting", async () => {
    await expect(applyProposal("field_summary_post", { channelId: "C1", threadTs: null, start: "x", end: "2026-08-31" })).rejects.toThrow();
    expect(mocks.postFieldSummary).not.toHaveBeenCalled();
  });
});
