/**
 * Typed Slack Web API client. SERVER-ONLY.
 *
 * SLACK_TOKEN (+ optional SLACK_WORKSPACE) are read from process.env and never
 * exposed to the browser — only this module and app/api/policy/route.ts touch
 * them. The `server-only` import makes an accidental client import a build error.
 *
 * Fetches conversations.history for every tracked channel over [start, end],
 * resolving author ids → display names via one users.list call. Mirrors the
 * shape/discipline of lib/jira.ts.
 */
import "server-only";
import type { Period } from "./period";
import { TRACKED_CHANNELS } from "./slackChannels";
import type { SlackMessage } from "./policySchedule";
import { toSlackFiles, type RawFile } from "./slackFiles";

const API = "https://slack.com/api";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SlackError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

function token(): string {
  const value = process.env.SLACK_TOKEN;
  if (!value) throw new SlackError("SLACK_TOKEN is not set on the server.");
  return value;
}

interface SlackOk {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/** GET a Slack Web API method with bearer auth; throws SlackError on transport or API error. */
async function call<T extends SlackOk>(method: string, params: URLSearchParams): Promise<T> {
  const res = await fetch(`${API}/${method}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token()}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new SlackError(`Slack ${method} returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as T;
  if (!body.ok) {
    // 502: the request reached Slack but it rejected it (auth/scope/etc.).
    throw new SlackError(`Slack ${method} error: ${body.error ?? "unknown"}`, 502);
  }
  return body;
}

interface UsersListResponse extends SlackOk {
  members: {
    id: string;
    profile?: { display_name?: string; real_name?: string };
    real_name?: string;
  }[];
}

/** Build an id → display-name map from a users.list page-walk. */
async function userMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const page = await call<UsersListResponse>("users.list", params);
    for (const u of page.members ?? []) {
      const name = u.profile?.display_name || u.profile?.real_name || u.real_name || u.id;
      map.set(u.id, name);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return map;
}

interface HistoryResponse extends SlackOk {
  messages: { user?: string; bot_id?: string; ts: string; text?: string; files?: RawFile[] }[];
}

function permalink(channelId: string, ts: string): string {
  // This bot is built only for the Orients workspace; default the subdomain so
  // permalinks work without SLACK_WORKSPACE, while still allowing an override.
  const workspace = process.env.SLACK_WORKSPACE || "orientsai";
  return `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

/**
 * A YYYY-MM-DD day → Slack `oldest`/`latest` bound (Unix epoch seconds, fractional
 * allowed). Start of day for `oldest`; end of day (…59.999) for `latest`, so the
 * full final second of the day is inclusive.
 */
function epoch(day: string, endOfDay = false): string {
  const midnight = new Date(`${day}T00:00:00.000Z`).getTime();
  const ms = endOfDay ? midnight + 86_399_999 : midnight;
  return String(ms / 1000);
}

/**
 * Fetch messages from every tracked channel within [period.start, period.end]
 * (inclusive), normalized to SlackMessage with the channel NAME and resolved
 * author display names. Pages conversations.history via cursor until exhausted.
 */
export async function fetchMessages(period: Period): Promise<SlackMessage[]> {
  if (!DATE_RE.test(period.start) || !DATE_RE.test(period.end)) {
    throw new SlackError(`Period bounds must be YYYY-MM-DD: start=${period.start} end=${period.end}`);
  }
  // Assert the token is present before any network work (clear config error).
  token();
  // Fail loud if the committed channel ids are still placeholders.
  const unconfigured = TRACKED_CHANNELS.filter((c) => c.id.includes("REPLACE_ME"));
  if (unconfigured.length > 0) {
    throw new SlackError(
      `Tracked channel ids not configured — replace the *_REPLACE_ME placeholders in lib/slackChannels.ts (${unconfigured.map((c) => c.name).join(", ")}).`,
    );
  }

  const users = await userMap();
  const oldest = epoch(period.start);
  const latest = epoch(period.end, true);
  const collected: SlackMessage[] = [];

  for (const channel of TRACKED_CHANNELS) {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        channel: channel.id,
        oldest,
        latest,
        inclusive: "true",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);
      const page = await call<HistoryResponse>("conversations.history", params);
      for (const m of page.messages ?? []) {
        // Include human messages and bot messages that carry text+files (e.g. the
        // stats-bot daily summary). Pure system messages (no user AND no bot_id)
        // are skipped to avoid noise.
        if (!m.user && !m.bot_id) continue;
        const authorId = m.user ?? m.bot_id ?? "";
        collected.push({
          channel: channel.name,
          authorId,
          author: m.user ? (users.get(m.user) ?? m.user) : (m.bot_id ?? "bot"),
          ts: m.ts,
          isoTime: new Date(Number(m.ts) * 1000).toISOString(),
          text: m.text ?? "",
          permalink: permalink(channel.id, m.ts),
          files: toSlackFiles(m.files),
        });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  return collected;
}

/** Download a Slack file (e.g. the stats-bot image) as base64. Needs files:read. */
export async function downloadFileBase64(
  urlPrivate: string,
): Promise<{ base64: string; mediaType: string }> {
  const res = await fetch(urlPrivate, { headers: { Authorization: `Bearer ${token()}` }, cache: "no-store" });
  if (!res.ok) {
    throw new SlackError(`Slack file download returned ${res.status} ${res.statusText}`, res.status);
  }
  const mediaType = res.headers.get("content-type") ?? "";
  if (!mediaType.startsWith("image/")) {
    throw new SlackError(`Expected an image but got "${mediaType}" — is the files:read scope granted?`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mediaType };
}
