/**
 * Resolve Slack message permalinks into readable text for the agent.
 *
 * Two entry points share one fetch path:
 *  - `resolveSlackLink(url, opts)` — one link → rendered message/thread (the
 *    `slack_read_link` tool and the `npm run slack-link` CLI).
 *  - `expandSlackLinks(text, opts)` — every permalink in an incoming question →
 *    ONE context block the surfaces prepend deterministically, so a pasted link
 *    is read without the model having to notice it (soft-fail per link).
 *
 * Trust boundaries:
 *  - `allowedChannelIds` binds a surface to the channels it may read. The
 *    approver-only agent surfaces (DM/@mention/CLI) leave it unset; the
 *    pilot-facing verdict-thread chat binds it to the verdict's own channel, so a
 *    pilot cannot make the bot repeat a private channel they are not in.
 *  - The thread root is taken from Slack's own message metadata, never from the
 *    URL's `thread_ts` alone — a crafted link cannot pair message A with thread B.
 *  - Each link has a wall-clock deadline so a huge or rate-limited thread cannot
 *    freeze the turn.
 *
 * Fetches LIVE via @/lib/slack (server-only glue; the pure parse/render lives in
 * lib/slackLinks.ts). Tests mock @/lib/slack.
 */
import { fetchMessageByTs, fetchThreadMessages, SlackError, type ThreadMessage } from "@/lib/slack";
import {
  parseSlackPermalink,
  extractSlackPermalinks,
  renderLinkedThread,
  formatLinkBlocks,
  type SlackLinkRef,
  type LinkedThread,
} from "@/lib/slackLinks";

/** Max links auto-expanded per question — more than this is a paste dump, not a question. */
const MAX_AUTO_LINKS = 3;
/** Per-link wall-clock budget (the agent loop itself has ~50s). */
const LINK_TIMEOUT_MS = 12_000;
/** Thread pages fetched per link (200 msgs each) — rendering keeps ≤40 anyway. */
const THREAD_MAX_PAGES = 2;

export class SlackLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackLinkError";
  }
}

export interface LinkReadOptions {
  /** Channels this surface may read; unset = any channel the bot is in. */
  allowedChannelIds?: string[];
  timeoutMs?: number;
}

function ukSlackError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not_in_channel|channel_not_found/.test(msg)) return "бот не в цьому каналі — додайте його (/invite) і повторіть";
  if (/thread_not_found|message_not_found/.test(msg)) return "повідомлення не знайдено (видалене або ts неправильний)";
  if (/missing_scope/.test(msg)) return "боту бракує Slack-дозволу читати цей канал";
  if (/SLACK_TOKEN/.test(msg)) return "SLACK_TOKEN не налаштований";
  return err instanceof SlackError ? `Slack: ${msg}` : msg;
}

function assertAllowed(ref: SlackLinkRef, allowed?: string[]): void {
  if (allowed && !allowed.includes(ref.channelId)) {
    throw new SlackLinkError(
      `посилання веде в інший канал (<#${ref.channelId}>) — тут читаю лише ${allowed.map((c) => `<#${c}>`).join(", ")}`,
    );
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlackLinkError(`не встиг прочитати — Slack не відповів за ${Math.round(ms / 1000)} с`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch the linked message and, when Slack says it belongs to a thread (a parent
 * with replies OR a reply), the whole thread. The root comes from the message's
 * own `thread_ts`; the URL's `thread_ts` is only a hint and is ignored when it
 * disagrees. A thread that does not contain the linked ts is discarded.
 */
export async function fetchLinkedThread(ref: SlackLinkRef): Promise<LinkedThread> {
  const msg = await fetchMessageByTs(ref.channelId, ref.ts);
  if (!msg) throw new SlackLinkError("повідомлення не знайдено (видалене або ts неправильний)");
  const root = msg.threadTs;
  const inThread = root !== undefined && (root !== msg.ts || (msg.replyCount ?? 0) > 0);
  let messages: ThreadMessage[] = [msg];
  if (inThread && root) {
    const thread = await fetchThreadMessages(ref.channelId, root, { maxPages: THREAD_MAX_PAGES });
    if (thread.some((m) => m.ts === ref.ts)) messages = thread;
  }
  return { channelId: ref.channelId, messages, linkedTs: ref.ts };
}

async function readOne(ref: SlackLinkRef, opts: LinkReadOptions): Promise<{ thread: LinkedThread; rendered: string }> {
  assertAllowed(ref, opts.allowedChannelIds);
  try {
    const thread = await withTimeout(fetchLinkedThread(ref), opts.timeoutMs ?? LINK_TIMEOUT_MS);
    return { thread, rendered: renderLinkedThread(thread) };
  } catch (err) {
    if (err instanceof SlackLinkError) throw err;
    throw new SlackLinkError(ukSlackError(err));
  }
}

/** One permalink → rendered text. Throws SlackLinkError (Ukrainian) on a bad
 *  URL, a channel outside `allowedChannelIds`, a timeout, or any Slack failure. */
export async function resolveSlackLink(
  url: string,
  opts: LinkReadOptions = {},
): Promise<{ ref: SlackLinkRef; thread: LinkedThread; rendered: string }> {
  const ref = parseSlackPermalink(url);
  if (!ref) throw new SlackLinkError(`це не посилання на повідомлення Slack: ${url}`);
  const { thread, rendered } = await readOne(ref, opts);
  return { ref, thread, rendered };
}

export interface ExpandOptions extends LinkReadOptions {
  /** The thread the question itself came from — links into it are already in
   *  the injected thread context, so they are skipped. */
  skipThread?: { channelId: string; threadTs?: string };
  maxLinks?: number;
}

/**
 * Find every Slack permalink in `text`, resolve each (best-effort) and return one
 * context block, or null when the text carries no (new) links. Never throws.
 */
export async function expandSlackLinks(text: string, opts: ExpandOptions = {}): Promise<string | null> {
  const refs = extractSlackPermalinks(text).filter((r) => {
    const skip = opts.skipThread;
    if (!skip || r.channelId !== skip.channelId) return true;
    return !(skip.threadTs && (r.ts === skip.threadTs || r.threadTs === skip.threadTs));
  });
  if (refs.length === 0) return null;
  const items: Array<{ url: string; rendered: string } | { url: string; error: string }> = [];
  for (const ref of refs.slice(0, opts.maxLinks ?? MAX_AUTO_LINKS)) {
    try {
      const { rendered } = await readOne(ref, opts);
      items.push({ url: ref.url, rendered });
    } catch (err) {
      items.push({ url: ref.url, error: err instanceof SlackLinkError ? err.message : ukSlackError(err) });
    }
  }
  const skipped = refs.length - items.length;
  const block = formatLinkBlocks(items);
  return block && skipped > 0 ? `${block}\n\n(ще ${skipped} посилань не розгорнуто — попроси прочитати їх окремо)` : block;
}
