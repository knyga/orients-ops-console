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
