/**
 * Typed Jira Cloud client. SERVER-ONLY.
 *
 * Credentials are read from process.env and never exposed to the browser —
 * only this module and app/api/jira/route.ts touch them. The `server-only`
 * import makes an accidental client import a build error.
 *
 * Uses the current search endpoint `/rest/api/3/search/jql` (the classic
 * `/rest/api/3/search` with startAt/total paging is deprecated on Jira Cloud);
 * it returns { issues, isLast, nextPageToken } with no total.
 */
import "server-only";
import type { JiraIssue } from "./jiraStats";
import type { SprintIssue } from "./sprintReport";

const API_VERSION = "application/json";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKeys: string[];
  storyPointsField: string;
}

function config(): JiraConfig {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  const projectKeys = (process.env.JIRA_PROJECT_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const storyPointsField = process.env.JIRA_STORY_POINTS_FIELD;

  if (!baseUrl) throw new JiraError("JIRA_BASE_URL is not set on the server.");
  if (!email) throw new JiraError("JIRA_EMAIL is not set on the server.");
  if (!apiToken) throw new JiraError("JIRA_API_TOKEN is not set on the server.");
  if (projectKeys.length === 0)
    throw new JiraError("JIRA_PROJECT_KEYS is not set on the server.");
  if (!storyPointsField)
    throw new JiraError("JIRA_STORY_POINTS_FIELD is not set on the server.");

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    email,
    apiToken,
    projectKeys,
    storyPointsField,
  };
}

function authHeader(cfg: JiraConfig): string {
  const basic = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
  return `Basic ${basic}`;
}

/** Raw shape of one issue in the search response (only the fields we request). */
interface RawIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    assignee?: { accountId: string; displayName: string } | null;
  };
  changelog?: {
    histories?: {
      created: string;
      items: { field: string; fromString: string | null; toString: string | null }[];
    }[];
  };
}

interface SearchResponse {
  issues: RawIssue[];
  isLast?: boolean;
  nextPageToken?: string;
}

function mapIssue(raw: RawIssue, storyPointsField: string): JiraIssue {
  const sp = raw.fields[storyPointsField];
  return {
    key: raw.key,
    summary: raw.fields.summary ?? "",
    assignee: raw.fields.assignee
      ? {
          accountId: raw.fields.assignee.accountId,
          displayName: raw.fields.assignee.displayName,
        }
      : null,
    storyPoints: typeof sp === "number" ? sp : null,
    histories: (raw.changelog?.histories ?? []).map((h) => ({
      created: h.created,
      items: h.items.map((it) => ({
        field: it.field,
        fromString: it.fromString,
        toString: it.toString,
      })),
    })),
  };
}

/**
 * Fetch all issues resolved within [start, end] (inclusive) across the
 * configured projects, with sprint changelog. Pages via nextPageToken until
 * the server reports the last page.
 *
 * @param start inclusive period start, `YYYY-MM-DD`.
 * @param end   inclusive period end, `YYYY-MM-DD`.
 */
export async function fetchResolvedIssues(
  start: string,
  end: string,
): Promise<JiraIssue[]> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new JiraError(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }

  const cfg = config();
  // `resolved <= "end"` alone means end-of-day-00:00, which would drop issues
  // resolved during the end day; "<end> 23:59" makes the bound inclusive.
  const jql =
    `project in (${cfg.projectKeys.join(",")}) ` +
    `AND resolved >= "${start}" AND resolved <= "${end} 23:59" ` +
    `ORDER BY resolved ASC`;

  const collected: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      jql,
      maxResults: "100",
      fields: ["summary", "assignee", "resolutiondate", "status", cfg.storyPointsField].join(","),
      expand: "changelog",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);

    const url = `${cfg.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: API_VERSION, Authorization: authHeader(cfg) },
      // Always hit Jira live; reporting must reflect current truth.
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(
        `Jira API returned ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
        res.status,
      );
    }

    const page = (await res.json()) as SearchResponse;
    for (const raw of page.issues ?? []) {
      collected.push(mapIssue(raw, cfg.storyPointsField));
    }
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);

  return collected;
}

const CONTENT_TYPE = "application/json";

/** Minimal plain-text → Atlassian Document Format. Blank lines split paragraphs;
 *  URLs get a link mark (ADF renders bare URLs as dead text). Jira Cloud v3
 *  requires ADF for description/comment bodies (plain strings 400). */
export function textToAdf(text: string): object {
  const URL_RE = /https?:\/\/\S+/g;
  const inline = (p: string): object[] => {
    const nodes: object[] = [];
    let last = 0;
    for (const m of p.matchAll(URL_RE)) {
      if (m.index > last) nodes.push({ type: "text", text: p.slice(last, m.index) });
      nodes.push({ type: "text", text: m[0], marks: [{ type: "link", attrs: { href: m[0] } }] });
      last = m.index + m[0].length;
    }
    if (last < p.length) nodes.push({ type: "text", text: p.slice(last) });
    return nodes;
  };
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim());
  const content = (paras.length ? paras : [""]).map((p) => ({
    type: "paragraph",
    content: p ? inline(p) : [],
  }));
  return { type: "doc", version: 1, content };
}

async function jiraWrite(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<unknown> {
  const cfg = config();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      Accept: API_VERSION,
      "Content-Type": CONTENT_TYPE,
      Authorization: authHeader(cfg),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new JiraError(
      `Jira API returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
      res.status,
    );
  }
  const raw = await res.text();
  return raw ? JSON.parse(raw) : {};
}

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  description: string;
  issueType?: string;
  assigneeAccountId?: string | null;
}
export interface CreatedIssue {
  key: string;
  url: string;
}

export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    summary: input.summary,
    issuetype: { name: input.issueType ?? "Task" },
    description: textToAdf(input.description),
  };
  if (input.assigneeAccountId) fields.assignee = { accountId: input.assigneeAccountId };
  const out = (await jiraWrite("/rest/api/3/issue", "POST", { fields })) as { key: string };
  return { key: out.key, url: `${config().baseUrl}/browse/${out.key}` };
}

export async function addComment(key: string, body: string): Promise<void> {
  await jiraWrite(`/rest/api/3/issue/${key}/comment`, "POST", { body: textToAdf(body) });
}

export async function updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
  await jiraWrite(`/rest/api/3/issue/${key}`, "PUT", { fields });
}

export async function transitionIssue(key: string, transitionId: string): Promise<void> {
  await jiraWrite(`/rest/api/3/issue/${key}/transitions`, "POST", {
    transition: { id: transitionId },
  });
}

/** The scrum board sprints live on. Board 1 is the team's ATP board — hardcoded
 *  like DEFAULT_PROJECT (a board id is config, not a secret); JIRA_BOARD_ID
 *  can override it. */
export function boardIdFromEnv(): number {
  return Number(process.env.JIRA_BOARD_ID ?? "1");
}

export interface Sprint {
  id: number;
  name: string;
  state: string;
  /** ISO timestamps from Jira; absent on sprints never started/planned. */
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

export async function listSprints(
  boardId: number,
  state: "active" | "future" | "closed",
): Promise<Sprint[]> {
  const cfg = config();
  const sprints: Sprint[] = [];
  let startAt = 0;
  let isLast = false;
  while (!isLast) {
    const params = new URLSearchParams({ state, startAt: String(startAt), maxResults: "50" });
    const res = await fetch(`${cfg.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?${params}`, {
      headers: { Accept: API_VERSION, Authorization: authHeader(cfg) },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JiraError(
        `Jira API returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    const page = (await res.json()) as { isLast?: boolean; values?: Sprint[] };
    const values = page.values ?? [];
    for (const s of values)
      sprints.push({
        id: s.id,
        name: s.name,
        state: s.state,
        startDate: s.startDate,
        endDate: s.endDate,
        completeDate: s.completeDate,
      });
    isLast = page.isLast !== false;
    startAt += values.length;
  }
  return sprints;
}

export async function createSprint(boardId: number, name: string): Promise<Sprint> {
  const out = (await jiraWrite("/rest/agile/1.0/sprint", "POST", {
    name,
    originBoardId: boardId,
  })) as Sprint;
  return { id: out.id, name: out.name, state: out.state };
}

export async function moveIssueToSprint(sprintId: number, key: string): Promise<void> {
  await jiraWrite(`/rest/agile/1.0/sprint/${sprintId}/issue`, "POST", { issues: [key] });
}

export interface SearchRow {
  key: string;
  summary: string;
  status: string;
}

/** Distinct sprints an issue has ever belonged to, from its Sprint-field
 *  changelog. Each Sprint change records the full sprint set in from/toString
 *  (comma-separated names); the union across all changes is every sprint the
 *  issue lived in. No Sprint history → it sits in exactly its current sprint → 1. */
function deriveSprintCount(histories: JiraIssue["histories"]): number {
  const names = new Set<string>();
  for (const h of histories) {
    for (const it of h.items) {
      if (it.field !== "Sprint") continue;
      for (const raw of [it.fromString, it.toString]) {
        for (const name of (raw ?? "").split(",")) {
          const trimmed = name.trim();
          if (trimmed) names.add(trimmed);
        }
      }
    }
  }
  return names.size > 0 ? names.size : 1;
}

interface RawSprintIssue {
  key: string;
  fields: {
    summary?: string;
    assignee?: { accountId: string; displayName: string } | null;
    status?: { name?: string; statusCategory?: { name?: string } };
  };
  changelog?: {
    histories?: {
      items: { field: string; fromString: string | null; toString: string | null }[];
    }[];
  };
}

function mapSprintIssue(raw: RawSprintIssue): SprintIssue {
  const histories = (raw.changelog?.histories ?? []).map((h) => ({
    created: "",
    items: (h.items ?? []).map((it) => ({
      field: it.field,
      fromString: it.fromString,
      toString: it.toString,
    })),
  }));
  return {
    key: raw.key,
    summary: raw.fields.summary ?? "",
    assignee: raw.fields.assignee
      ? { accountId: raw.fields.assignee.accountId, displayName: raw.fields.assignee.displayName }
      : null,
    statusName: raw.fields.status?.name ?? "",
    statusCategory: raw.fields.status?.statusCategory?.name ?? "",
    sprintCount: deriveSprintCount(histories),
  };
}

/** Page a JQL search returning the rich SprintIssue shape (status category +
 *  Sprint-changelog-derived sprint count). Shared by fetchSprintIssues and
 *  fetchIssuesByKeys. */
async function fetchSprintScoped(jql: string): Promise<SprintIssue[]> {
  const cfg = config();
  const collected: SprintIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      jql,
      maxResults: "100",
      fields: ["summary", "assignee", "status"].join(","),
      expand: "changelog",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const url = `${cfg.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: API_VERSION, Authorization: authHeader(cfg) },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new JiraError(
        `Jira API returned ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
        res.status,
      );
    }
    const page = (await res.json()) as { issues?: RawSprintIssue[]; isLast?: boolean; nextPageToken?: string };
    for (const raw of page.issues ?? []) collected.push(mapSprintIssue(raw));
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
  } while (nextPageToken);
  return collected;
}

/** All issues currently in the given sprint, with status category + sprint count. */
export async function fetchSprintIssues(sprintId: number): Promise<SprintIssue[]> {
  return fetchSprintScoped(`sprint = ${sprintId} ORDER BY status ASC`);
}

/** Live status + sprint count for an explicit set of issue keys (the frozen
 *  baseline re-fetched at report time). Empty input → no query. */
export async function fetchIssuesByKeys(keys: string[]): Promise<SprintIssue[]> {
  if (keys.length === 0) return [];
  const list = keys.map((k) => `"${k}"`).join(",");
  return fetchSprintScoped(`key in (${list})`);
}

export async function searchIssues(jql: string, max = 20): Promise<SearchRow[]> {
  const cfg = config();
  const params = new URLSearchParams({
    jql,
    maxResults: String(max),
    fields: ["summary", "status"].join(","),
  });
  const url = `${cfg.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: API_VERSION, Authorization: authHeader(cfg) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new JiraError(
      `Jira API returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
      res.status,
    );
  }
  const page = (await res.json()) as {
    issues?: { key: string; fields?: { summary?: string; status?: { name?: string } } }[];
  };
  return (page.issues ?? []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary ?? "",
    status: i.fields?.status?.name ?? "",
  }));
}
