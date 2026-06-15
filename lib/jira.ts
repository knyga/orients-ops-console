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
