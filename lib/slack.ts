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
 * Also exposes fetchRawMessages — history PLUS thread replies and edit markers — the input the local Slack mirror (lib/slackMirror) stores.
 */
import "server-only";
import type { Period } from "./period";
import { TRACKED_CHANNELS, type SlackChannel } from "./slackChannels";
import type { SlackFile, SlackMessage } from "./policySchedule";
import { toSlackFiles, type RawFile } from "./slackFiles";
import { sendTracked, type SendMeta } from "./sendTracked";

export type { SendMeta };

const API = "https://slack.com/api";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RETRIES = 5;

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

/** GET a Slack Web API method with bearer auth; retries on 429, throws SlackError otherwise. */
async function call<T extends SlackOk>(method: string, params: URLSearchParams): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API}/${method}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token()}` },
      cache: "no-store",
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
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

/** Public directory snapshot [{ id, name }] from a users.list page-walk. */
export async function listUsers(): Promise<{ id: string; name: string }[]> {
  const map = await userMap();
  return [...map.entries()].map(([id, name]) => ({ id, name }));
}

interface HistoryResponse extends SlackOk {
  messages: { user?: string; bot_id?: string; ts: string; text?: string; files?: RawFile[] }[];
}

/**
 * A Slack message permalink for a (channel id, ts). Exported for the events
 * webhook, which builds an evidence link for a reply it receives. Pure string
 * build (no token), but lives here next to the workspace-subdomain convention.
 */
export function permalinkFor(channelId: string, ts: string): string {
  // This bot is built only for the Orients workspace; default the subdomain so
  // permalinks work without SLACK_WORKSPACE, while still allowing an override.
  const workspace = process.env.SLACK_WORKSPACE || "orientsai";
  return `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

function permalink(channelId: string, ts: string): string {
  return permalinkFor(channelId, ts);
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

/** Throw if any channel id is still a lib/slackChannels placeholder. */
function assertChannelsConfigured(channels: SlackChannel[]): void {
  const unconfigured = channels.filter((c) => c.id.includes("REPLACE_ME"));
  if (unconfigured.length > 0) {
    throw new SlackError(
      `Tracked channel ids not configured — replace the *_REPLACE_ME placeholders in lib/slackChannels.ts (${unconfigured.map((c) => c.name).join(", ")}).`,
    );
  }
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
  assertChannelsConfigured(TRACKED_CHANNELS);

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

/** A mirror-bound message: SlackMessage fields + thread/edit markers from Slack. */
export interface RawSlackMessage {
  channel: string;
  ts: string;
  authorId: string;
  author: string;
  isoTime: string;
  text: string;
  permalink: string;
  files?: SlackFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: string;
}

interface RawHistoryMessage {
  user?: string;
  bot_id?: string;
  ts: string;
  text?: string;
  files?: RawFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: { ts?: string };
}

interface RawHistoryResponse extends SlackOk {
  messages: RawHistoryMessage[];
}

/**
 * Fetch raw messages for [period] from the given channels (default: all tracked),
 * INCLUDING thread replies and `edited` markers — the input the local mirror
 * (lib/slackMirror) stores. Pages conversations.history, then for each parent with
 * replies pages conversations.replies. Additive: does not touch fetchMessages.
 */
export async function fetchRawMessages(
  period: Period,
  channels: SlackChannel[] = TRACKED_CHANNELS,
): Promise<RawSlackMessage[]> {
  if (!DATE_RE.test(period.start) || !DATE_RE.test(period.end)) {
    throw new SlackError(`Period bounds must be YYYY-MM-DD: start=${period.start} end=${period.end}`);
  }
  token();
  assertChannelsConfigured(channels);
  const users = await userMap();
  const oldest = epoch(period.start);
  const latest = epoch(period.end, true);
  const out: RawSlackMessage[] = [];

  const normalize = (channel: SlackChannel, m: RawHistoryMessage): RawSlackMessage | null => {
    if (!m.user && !m.bot_id) return null;
    return {
      channel: channel.name,
      ts: m.ts,
      authorId: m.user ?? m.bot_id ?? "",
      author: m.user ? (users.get(m.user) ?? m.user) : (m.bot_id ?? "bot"),
      isoTime: new Date(Number(m.ts) * 1000).toISOString(),
      text: m.text ?? "",
      permalink: permalink(channel.id, m.ts),
      files: toSlackFiles(m.files),
      thread_ts: m.thread_ts,
      reply_count: m.reply_count,
      edited: m.edited?.ts,
    };
  };

  for (const channel of channels) {
    const parents: RawHistoryMessage[] = [];
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
      const page = await call<RawHistoryResponse>("conversations.history", params);
      for (const m of page.messages ?? []) {
        const n = normalize(channel, m);
        if (n) {
          out.push(n);
          if ((m.reply_count ?? 0) > 0) parents.push(m);
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // conversations.history returns thread parents only — page each parent's replies.
    for (const parent of parents) {
      let rcursor: string | undefined;
      do {
        const params = new URLSearchParams({ channel: channel.id, ts: parent.ts, limit: "200" });
        if (rcursor) params.set("cursor", rcursor);
        const page = await call<RawHistoryResponse>("conversations.replies", params);
        for (const m of page.messages ?? []) {
          if (m.ts === parent.ts) continue; // replies echoes the parent first — skip it
          const n = normalize(channel, m);
          if (n) out.push(n);
        }
        rcursor = page.response_metadata?.next_cursor || undefined;
      } while (rcursor);
    }
  }

  return out;
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

async function rawPost(channelId: string, text: string, threadTs?: string): Promise<string> {
  const res = await fetch(`${API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    cache: "no-store",
    body: JSON.stringify({ channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  if (!res.ok) {
    throw new SlackError(`Slack chat.postMessage returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as SlackOk & { ts?: string };
  if (!body.ok) {
    throw new SlackError(
      `Slack chat.postMessage error: ${body.error ?? "unknown"} (is the chat:write scope granted and the bot in the channel?)`,
      502,
    );
  }
  return body.ts ?? "";
}

/**
 * Post a message to a channel. SERVER-ONLY; needs the `chat:write` scope. Every
 * send is recorded + deduped via sendTracked (reserve-then-send). `meta.key`
 * identifies the logical action; a repeat call with the same key is skipped and
 * returns the original ts. Returns the posted ts.
 */
export async function postMessage(
  channelId: string,
  text: string,
  meta: SendMeta,
  threadTs?: string,
): Promise<string> {
  return sendTracked(
    {
      channelId,
      text,
      kind: threadTs ? "reply" : "post",
      threadTs: threadTs ?? null,
      ts: null,
      meta,
    },
    () => rawPost(channelId, text, threadTs),
  );
}

/**
 * Open (or fetch) the bot↔user DM channel via conversations.open and return its
 * channel id for postMessage. SERVER-ONLY; needs `im:write` (+ `chat:write` to
 * post). Throws SlackError on failure.
 */
export async function openDm(userId: string): Promise<string> {
  const res = await fetch(`${API}/conversations.open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json; charset=utf-8" },
    cache: "no-store",
    body: JSON.stringify({ users: userId }),
  });
  if (!res.ok) throw new SlackError(`Slack conversations.open returned ${res.status} ${res.statusText}`, res.status);
  const body = (await res.json()) as SlackOk & { channel?: { id?: string } };
  if (!body.ok || !body.channel?.id) {
    throw new SlackError(`Slack conversations.open error: ${body.error ?? "unknown"} (is the im:write scope granted?)`, 502);
  }
  return body.channel.id;
}

async function rawUpdate(channelId: string, ts: string, text: string): Promise<void> {
  const res = await fetch(`${API}/chat.update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    cache: "no-store",
    body: JSON.stringify({ channel: channelId, ts, text }),
  });
  if (!res.ok) {
    throw new SlackError(`Slack chat.update returned ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as SlackOk;
  if (!body.ok) {
    throw new SlackError(`Slack chat.update error: ${body.error ?? "unknown"}`, 502);
  }
}

/**
 * Edit one of the bot's own messages. SERVER-ONLY; needs `chat:write`. Recorded +
 * deduped via sendTracked (kind "edit"); the row's ts is the edited message's ts.
 */
export async function updateMessage(
  channelId: string,
  ts: string,
  text: string,
  meta: SendMeta,
): Promise<void> {
  await sendTracked(
    { channelId, text, kind: "edit", threadTs: null, ts, meta },
    async () => {
      await rawUpdate(channelId, ts, text);
      return ts;
    },
  );
}
