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
