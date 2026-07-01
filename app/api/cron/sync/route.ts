/**
 * Vercel Cron: incrementally sync the tracked Slack channels into the mirror
 * (Postgres), so downstream verdicts see fresh #datasets / #field-qa posts
 * between human runs. Same per-channel logic as the `slack-sync` CLI
 * (lib/syncChannels). Guarded by CRON_SECRET — Vercel injects the bearer on
 * scheduled invocations; anyone else gets 401. Scheduled in vercel.json.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { syncAllChannels } from "@/lib/syncChannels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });

  const { summaries, failures } = await syncAllChannels({ mode: "incremental", window: 7 });
  // Surface per-channel counts in the response for the Vercel cron logs.
  return Response.json({ ok: failures === 0, failures, summaries }, { status: failures === 0 ? 200 : 500 });
}
