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
  };
}

export type ParsedSlackEvent =
  | { kind: "challenge"; challenge: string }
  | { kind: "skip"; reason: string }
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
