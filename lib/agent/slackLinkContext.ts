/**
 * Resolve Slack message permalinks into readable text for the agent.
 *
 * Two entry points share one fetch path:
 *  - `resolveSlackLink(url)` — one link → rendered message/thread (the
 *    `slack_read_link` tool and the `npm run slack-link` CLI).
 *  - `expandSlackLinks(text, …)` — every permalink in an incoming question →
 *    ONE context block the surfaces prepend deterministically, so a pasted link
 *    is read without the model having to notice it (soft-fail per link).
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

export class SlackLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackLinkError";
  }
}

function ukSlackError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not_in_channel|channel_not_found/.test(msg)) return "бот не в цьому каналі — додайте його (/invite) і повторіть";
  if (/thread_not_found|message_not_found/.test(msg)) return "повідомлення не знайдено (видалене або ts неправильний)";
  if (/missing_scope/.test(msg)) return "боту бракує Slack-дозволу читати цей канал";
  if (/SLACK_TOKEN/.test(msg)) return "SLACK_TOKEN не налаштований";
  return err instanceof SlackError ? `Slack: ${msg}` : msg;
}

/** Fetch the linked message and, when it belongs to a thread (parent with
 *  replies OR a reply), the whole thread. */
export async function fetchLinkedThread(ref: SlackLinkRef): Promise<LinkedThread> {
  const msg = await fetchMessageByTs(ref.channelId, ref.ts);
  if (!msg) throw new SlackLinkError("повідомлення не знайдено (видалене або ts неправильний)");
  const root = ref.threadTs ?? msg.threadTs;
  const inThread = root !== undefined && (root !== msg.ts || (msg.replyCount ?? 0) > 0);
  let messages: ThreadMessage[] = [msg];
  if (inThread && root) {
    const thread = await fetchThreadMessages(ref.channelId, root);
    if (thread.length > 0) messages = thread;
  }
  return { channelId: ref.channelId, messages, linkedTs: ref.ts };
}

/** One permalink → rendered text. Throws SlackLinkError (Ukrainian) on a bad
 *  URL; Slack failures are rethrown as SlackLinkError too. */
export async function resolveSlackLink(url: string): Promise<{ ref: SlackLinkRef; thread: LinkedThread; rendered: string }> {
  const ref = parseSlackPermalink(url);
  if (!ref) throw new SlackLinkError(`це не посилання на повідомлення Slack: ${url}`);
  try {
    const thread = await fetchLinkedThread(ref);
    return { ref, thread, rendered: renderLinkedThread(thread) };
  } catch (err) {
    if (err instanceof SlackLinkError) throw err;
    throw new SlackLinkError(ukSlackError(err));
  }
}

export interface ExpandOptions {
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
      const thread = await fetchLinkedThread(ref);
      items.push({ url: ref.url, rendered: renderLinkedThread(thread) });
    } catch (err) {
      items.push({ url: ref.url, error: err instanceof SlackLinkError ? err.message : ukSlackError(err) });
    }
  }
  const skipped = refs.length - items.length;
  const block = formatLinkBlocks(items);
  return block && skipped > 0 ? `${block}\n\n(ще ${skipped} посилань не розгорнуто — попроси прочитати їх окремо)` : block;
}
