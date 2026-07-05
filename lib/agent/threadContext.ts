/**
 * Thread-context injection for the Slack agent (and its CLI twin).
 *
 * When the bot is @mentioned inside a thread, the agent loop otherwise sees only
 * the mention text + its own memory — never the surrounding human messages. This
 * module fetches the thread LIVE (the local Slack mirror is not on Vercel) and
 * renders a capped, oldest-first transcript that /api/agent/run prepends to the
 * question. formatThreadContext/parseThreadRef are pure; fetchThreadContext is
 * the server-only glue (via @/lib/slack).
 */
import { fetchThreadMessages, type ThreadMessage } from "@/lib/slack";
import { personForSlackId } from "@/lib/people";

const HEADER = "Контекст треду (Slack):";
const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_CHARS = 8_000;

export interface ThreadContextOptions {
  /** ts values to omit — the incoming mention and the bot's «думаю…» placeholder. */
  excludeTs?: string[];
  maxMessages?: number;
  maxChars?: number;
}

function authorLabel(m: ThreadMessage): string {
  if (m.user) return personForSlackId(m.user)?.name ?? `<@${m.user}>`;
  return "бот";
}

/** Render the transcript block, or null when no messages survive the filters. */
export function formatThreadContext(
  messages: ThreadMessage[],
  opts: ThreadContextOptions = {},
): string | null {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const excluded = new Set(opts.excludeTs ?? []);

  const kept = messages.filter((m) => !excluded.has(m.ts));
  if (kept.length === 0) return null;

  let lines = kept.map((m) => `[${authorLabel(m)}]: ${m.text}`);
  let dropped = 0;
  if (lines.length > maxMessages) {
    dropped = lines.length - maxMessages;
    lines = lines.slice(dropped);
  }
  // Drop oldest lines until the body fits the char budget.
  while (lines.length > 1 && lines.join("\n").length > maxChars) {
    lines.shift();
    dropped += 1;
  }

  const parts = [HEADER];
  if (dropped > 0) parts.push(`(${dropped} старіших повідомлень пропущено)`);
  parts.push(...lines);
  return parts.join("\n");
}

/**
 * Parse a thread reference: either "C123:1783244631.100559" or a Slack permalink
 * (https://…/archives/<CHANNEL>/p<16 digits>[?thread_ts=…]). A reply permalink's
 * thread_ts query param (the ROOT of the thread) wins over the p-ts.
 */
export function parseThreadRef(ref: string): { channelId: string; threadTs: string } | null {
  const pair = /^([A-Z][A-Z0-9]{6,}):(\d{10}\.\d{6})$/.exec(ref);
  if (pair) return { channelId: pair[1], threadTs: pair[2] };

  const url = /\/archives\/([A-Z][A-Z0-9]{6,})\/p(\d{16})/.exec(ref);
  if (!url) return null;
  const fromQuery = /[?&]thread_ts=(\d{10}\.\d{6})/.exec(ref)?.[1];
  const pTs = `${url[2].slice(0, 10)}.${url[2].slice(10)}`;
  return { channelId: url[1], threadTs: fromQuery ?? pTs };
}

/** Live fetch + format. Callers treat a throw as "proceed without context". */
export async function fetchThreadContext(
  channelId: string,
  threadTs: string,
  excludeTs?: string[],
): Promise<string | null> {
  const messages = await fetchThreadMessages(channelId, threadTs);
  return formatThreadContext(messages, { excludeTs });
}
