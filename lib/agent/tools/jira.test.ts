import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { searchIssues, createIssue, addComment, updateIssue, transitionIssue } = vi.hoisted(() => ({
  searchIssues: vi.fn(),
  createIssue: vi.fn(),
  addComment: vi.fn(),
  updateIssue: vi.fn(),
  transitionIssue: vi.fn(),
}));

vi.mock("@/lib/jira", () => ({ searchIssues, createIssue, addComment, updateIssue, transitionIssue }));
// lib/jiraRouting and lib/people are NOT mocked — they use real routing + registry to test integration

import { jiraTools, jiraCreateProposal } from "./jira";
import { findTool } from "./registry";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "ATP",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
  JIRA_MRLAB_PROJECT: "MRLAB",
};
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

describe("jira_search tool", () => {
  it("is a read tool and returns rows as text", async () => {
    const tool = findTool(jiraTools, "jira_search")!;
    expect(tool.kind).toBe("read");
    searchIssues.mockResolvedValue([{ key: "ATP-7", status: "Done", summary: "Fix" }]);
    const res = await tool.run!({ jql: "resolved >= startOfDay()" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("ATP-7");
    expect(res.content).toContain("Fix");
  });
});

describe("jiraCreateProposal (Mr-Lab routing)", () => {
  it("routes Тарас to MRLAB with assignee in the description echo", async () => {
    const p = await jiraCreateProposal({ person: "Taras", summary: "Fix export", description: "broken CSV" });
    expect(p.kind).toBe("jira_create");
    expect(p.echoUk).toContain("MRLAB");
    expect(p.echoUk).toContain("Taras Panasyuk");
  });

  it("apply() POSTs and returns the created key + url", async () => {
    createIssue.mockResolvedValue({ key: "MRLAB-3", url: "https://ex.atlassian.net/browse/MRLAB-3" });

    const p = await jiraCreateProposal({ person: "Taras", summary: "S", description: "" });
    const out = await p.apply();
    expect(out).toContain("MRLAB-3");
    expect(createIssue).toHaveBeenCalledWith({
      projectKey: "MRLAB",
      summary: "S",
      description: "Виконавець: Taras Panasyuk",
      assigneeAccountId: null,
    });
  });

  it("rejects an unknown person", async () => {
    await expect(jiraCreateProposal({ person: "Nobody McGhost", summary: "S", description: "" })).rejects.toThrow(
      /Unknown person/,
    );
  });
});

describe("jira write tools", () => {
  it("registers create/comment/transition/update as write tools with propose()", () => {
    for (const name of ["jira_create", "jira_comment", "jira_transition", "jira_update"]) {
      const t = findTool(jiraTools, name)!;
      expect(t.kind).toBe("write");
      expect(typeof t.propose).toBe("function");
    }
  });
});
