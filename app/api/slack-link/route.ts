/**
 * GET /api/slack-link?url=<Slack message permalink>
 *
 * Web twin of `npm run slack-link` / the agent's `slack_read_link` tool: resolves a
 * permalink into the message (or its whole thread) as JSON + the rendered
 * transcript. Read-only, live Slack fetch. Gated by the console auth proxy (not a
 * machine endpoint — `/api/slack/*` is the webhook namespace, this is not under it).
 */
import { resolveSlackLink, SlackLinkError } from "@/lib/agent/slackLinkContext";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url).searchParams.get("url")?.trim();
  if (!url) return Response.json({ error: "url query param required" }, { status: 400 });
  try {
    const { ref, thread, rendered } = await resolveSlackLink(url);
    return Response.json({
      url: ref.url,
      channelId: ref.channelId,
      ts: ref.ts,
      threadTs: ref.threadTs ?? null,
      messages: thread.messages,
      rendered,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // resolveSlackLink rethrows every Slack failure as SlackLinkError (Ukrainian):
    // bad URL → 400, missing server config → 500, anything Slack rejected → 502.
    if (err instanceof SlackLinkError) {
      const status = /не посилання/.test(message) ? 400 : /SLACK_TOKEN/.test(message) ? 500 : 502;
      return Response.json({ error: message }, { status });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
