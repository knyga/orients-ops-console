/**
 * Vercel Cron: incrementally sync the tracked Slack channels into the mirror
 * (Postgres), so downstream verdicts see fresh #datasets / #field-qa posts
 * between human runs. Same per-channel logic as the `slack-sync` CLI
 * (lib/syncChannels). Guarded by CRON_SECRET — Vercel injects the bearer on
 * scheduled invocations; anyone else gets 401. Scheduled in vercel.json.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { syncAllChannels } from "@/lib/syncChannels";
import { alertApprovers } from "@/lib/opsAlert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });

  try {
    const { summaries, failures } = await syncAllChannels({ mode: "incremental", window: 7 });
    // Surface per-channel counts in the response for the Vercel cron logs.
    return Response.json({ ok: failures === 0, failures, summaries }, { status: failures === 0 ? 200 : 500 });
  } catch (error) {
    // A thrown failure (config/DB, not a per-channel Slack hiccup — those are
    // counted in `failures`) would otherwise only reach the cron logs.
    await alertApprovers(error, "cron-sync", "cron");
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
