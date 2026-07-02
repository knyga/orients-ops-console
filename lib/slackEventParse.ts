/**
 * Pure parser for the Slack Events API envelope: classify an incoming POST body
 * as a url_verification challenge, an ignorable event, or an actionable human
 * thread reply — extracting the fields the events route needs (incl. the stable
 * `event_id` used for at-most-once dedup). No IO — unit-tested in isolation.
 */
export interface SlackEventBody {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
    channel_type?: string;
  };
}

export type ParsedSlackEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "skip"; reason: string }
  | { kind: "dm"; eventId: string | null; channelId: string; userId: string; text: string; ts: string }
  | { kind: "mention"; eventId: string | null; channelId: string; userId: string; text: string; ts: string; threadTs: string }
  | {
      kind: "actionable";
      eventId: string | null;
      channelId: string;
      userId: string;
      replyText: string;
      replyTs: string;
      threadTs: string;
    };

export function parseSlackEvent(body: SlackEventBody): ParsedSlackEvent {
  if (body.type === "url_verification") {
    return { kind: "challenge", challenge: body.challenge ?? "" };
  }
  if (body.type !== "event_callback") {
    return { kind: "skip", reason: "not-event-callback" };
  }
  const e = body.event;
  // An @mention of the bot in any channel → run the agent. Bot's own posts carry
  // bot_id and are ignored (no self-mention loop). threadTs = thread when the
  // mention is a reply, else the mention's own ts (so the answer threads under it).
  if (e?.type === "app_mention" && !e.bot_id && e.user && e.ts && e.channel) {
    return {
      kind: "mention",
      eventId: body.event_id ?? null,
      channelId: e.channel,
      userId: e.user,
      text: e.text ?? "",
      ts: e.ts,
      threadTs: e.thread_ts ?? e.ts,
    };
  }
  // A human DM to the bot (channel_type "im"): reply with the help text. Checked
  // before the thread-reply filter because a DM has no thread_ts. Bot posts and
  // edits/joins are excluded so the help reply never loops.
  if (e?.type === "message" && e.channel_type === "im" && !e.subtype && !e.bot_id && e.user && e.ts && e.channel) {
    return {
      kind: "dm",
      eventId: body.event_id ?? null,
      channelId: e.channel,
      userId: e.user,
      text: e.text ?? "",
      ts: e.ts,
    };
  }
  // Only human thread REPLIES (not bot posts, edits/joins, or top-level messages).
  if (
    !(
      e?.type === "message" &&
      !e.subtype &&
      !e.bot_id &&
      e.user &&
      e.ts &&
      e.thread_ts &&
      e.thread_ts !== e.ts &&
      e.channel
    )
  ) {
    return { kind: "skip", reason: "filter" };
  }
  return {
    kind: "actionable",
    eventId: body.event_id ?? null,
    channelId: e.channel,
    userId: e.user,
    replyText: e.text ?? "",
    replyTs: e.ts,
    threadTs: e.thread_ts,
  };
}

/** Remove a single leading Slack mention token (`<@U…>`/`<@U…|name>`) and trim. */
export function stripBotMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}

/** True iff `text` begins (after leading whitespace) with a Slack mention token. */
export function hasLeadingMention(text: string): boolean {
  return /^\s*<@[^>]+>/.test(text);
}
