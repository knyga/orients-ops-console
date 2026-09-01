import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listSprints, createSprint, moveIssueToSprint, boardIdFromEnv, textToAdf, searchIssues, JiraError } from "./jira";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "ATP",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
};
beforeEach(() => {
  Object.assign(process.env, ENV);
  delete process.env.JIRA_BOARD_ID;
});
afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(json), { status }));
}

describe("textToAdf", () => {
  it("keeps plain paragraphs as plain text nodes", () => {
    expect(textToAdf("hello\n\nworld")).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "world" }] },
      ],
    });
  });

  it("marks a URL as a clickable link (ADF renders bare URLs as dead text)", () => {
    const url = "https://orientsai.slack.com/archives/C1/p1700000000000001";
    expect(textToAdf(`Slack: ${url}`)).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Slack: " },
            { type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] },
          ],
        },
      ],
    });
  });

  it("links a URL in the middle of a sentence", () => {
    const adf = textToAdf("див. https://ex.com/a і далі") as {
      content: { content: { text: string; marks?: unknown[] }[] }[];
    };
    const nodes = adf.content[0].content;
    expect(nodes.map((n) => n.text)).toEqual(["див. ", "https://ex.com/a", " і далі"]);
    expect(nodes[1].marks).toEqual([{ type: "link", attrs: { href: "https://ex.com/a" } }]);
    expect(nodes[0].marks).toBeUndefined();
  });
});

describe("boardIdFromEnv", () => {
  it("defaults to board 1 (the ATP board)", () => {
    expect(boardIdFromEnv()).toBe(1);
  });

  it("honours JIRA_BOARD_ID", () => {
    process.env.JIRA_BOARD_ID = "7";
    expect(boardIdFromEnv()).toBe(7);
  });
});

describe("listSprints", () => {
  it("GETs the board's sprints filtered by state and maps id/name/state", async () => {
    const f = mockFetch(200, {
      isLast: true,
      values: [{ id: 1190, name: "ATP 40", state: "active", originBoardId: 1 }],
    });
    const out = await listSprints(1, "active");
    expect(out).toEqual([{ id: 1190, name: "ATP 40", state: "active" }]);
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/rest/agile/1.0/board/1/sprint");
    expect(url).toContain("state=active");
  });

  it("pages via startAt until isLast", async () => {
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isLast: false, values: [{ id: 1, name: "S 1", state: "future" }] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isLast: true, values: [{ id: 2, name: "S 2", state: "future" }] })),
      );
    const out = await listSprints(1, "future");
    expect(out.map((s) => s.id)).toEqual([1, 2]);
    expect(String(f.mock.calls[1][0])).toContain("startAt=1");
  });

  it("throws JiraError on a non-2xx response", async () => {
    mockFetch(403, { errorMessages: ["nope"] });
    await expect(listSprints(1, "active")).rejects.toThrow(/403/);
  });
});

/**
 * Jira Cloud does NOT 401 a search with a dead token — it falls back to
 * ANONYMOUS access and returns 200 with only anonymously-visible issues
 * (i.e. none), flagging the failure solely in the X-Seraph-LoginReason
 * response header. Bit us 2026-08-31: an expired token made the agent
 * confidently report «жодної задачі» for a month of real work. Every Jira
 * response must therefore be checked for that header, not just res.ok.
 */
describe("anonymous-fallback detection (X-Seraph-LoginReason)", () => {
  function mockAuthFailedFetch(json: unknown) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" },
      }),
    );
  }

  it("searchIssues throws JiraError 401 on a 200 that authenticated as anonymous", async () => {
    mockAuthFailedFetch({ issues: [], isLast: true });
    const err = await searchIssues("created >= 2026-08-01").catch((e) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).status).toBe(401);
    expect(String(err)).toMatch(/token/i);
  });

  it("listSprints throws JiraError 401 on a 200 that authenticated as anonymous", async () => {
    mockAuthFailedFetch({ isLast: true, values: [] });
    const err = await listSprints(1, "active").catch((e) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect((err as JiraError).status).toBe(401);
  });

  it("a normal 200 without the header still works", async () => {
    mockFetch(200, { issues: [], isLast: true });
    await expect(searchIssues("created >= 2026-08-01")).resolves.toEqual([]);
  });
});

describe("createSprint", () => {
  it("POSTs name + originBoardId and returns the created sprint", async () => {
    const f = mockFetch(201, { id: 1224, name: "ATP 41", state: "future" });
    const out = await createSprint(1, "ATP 41");
    expect(out).toEqual({ id: 1224, name: "ATP 41", state: "future" });
    expect(String(f.mock.calls[0][0])).toContain("/rest/agile/1.0/sprint");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body).toEqual({ name: "ATP 41", originBoardId: 1 });
  });
});

describe("moveIssueToSprint", () => {
  it("POSTs the issue key to the sprint's issue endpoint", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await moveIssueToSprint(1223, "ATP-1714");
    expect(String(f.mock.calls[0][0])).toContain("/rest/agile/1.0/sprint/1223/issue");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body).toEqual({ issues: ["ATP-1714"] });
  });
});
