import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { textToAdf, createIssue, addComment, searchIssues } from "./jira";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "OPS",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(json), { status }),
  );
}

describe("textToAdf", () => {
  it("wraps text as a one-paragraph ADF doc", () => {
    expect(textToAdf("hello")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    });
  });
  it("splits blank-line-separated paragraphs", () => {
    const doc = textToAdf("a\n\nb") as { content: unknown[] };
    expect(doc.content).toHaveLength(2);
  });
});

describe("createIssue", () => {
  it("POSTs to /rest/api/3/issue and returns key + browse url", async () => {
    const f = mockFetch(201, { key: "OPS-42" });
    const out = await createIssue({ projectKey: "OPS", summary: "S", description: "D" });
    expect(out).toEqual({ key: "OPS-42", url: "https://ex.atlassian.net/browse/OPS-42" });
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://ex.atlassian.net/rest/api/3/issue");
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(String(opts?.body));
    expect(body.fields.project).toEqual({ key: "OPS" });
    expect(body.fields.summary).toBe("S");
    expect(body.fields.issuetype).toEqual({ name: "Task" });
    expect(body.fields.description.type).toBe("doc");
    expect("assignee" in body.fields).toBe(false);
  });

  it("sets assignee when accountId given", async () => {
    const f = mockFetch(201, { key: "OPS-1" });
    await createIssue({ projectKey: "OPS", summary: "S", description: "D", assigneeAccountId: "acc-9" });
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.fields.assignee).toEqual({ accountId: "acc-9" });
  });

  it("throws JiraError on non-2xx", async () => {
    mockFetch(400, { errorMessages: ["bad"] });
    await expect(createIssue({ projectKey: "OPS", summary: "S", description: "D" })).rejects.toThrow(
      /Jira API returned 400/,
    );
  });
});

describe("searchIssues", () => {
  it("GETs /rest/api/3/search/jql and maps rows", async () => {
    mockFetch(200, {
      issues: [{ key: "OPS-7", fields: { summary: "Fix", status: { name: "To Do" } } }],
      isLast: true,
    });
    const rows = await searchIssues("project = OPS", 10);
    expect(rows).toEqual([{ key: "OPS-7", summary: "Fix", status: "To Do" }]);
  });
});

describe("addComment", () => {
  it("POSTs an ADF comment body", async () => {
    const f = mockFetch(201, {});
    await addComment("OPS-3", "note");
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://ex.atlassian.net/rest/api/3/issue/OPS-3/comment");
    const body = JSON.parse(String(opts?.body));
    expect(body.body.type).toBe("doc");
  });
});
