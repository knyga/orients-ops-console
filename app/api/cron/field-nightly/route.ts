/**
 * Vercel Cron: the autonomous nightly field pipeline. Runs
 * #datasets sync → field-qa extract → verdict compute → publish settled days to
 * #field-qa, over the catch-up window (current Kyiv month + the previous month
 * for the first few days after a month rolls over). Guarded by CRON_SECRET.
 * Scheduled in vercel.json. On any stage failure it DMs the operator (in
 * runNightly) and returns 500 so Vercel's cron-failure alerting fires too.
 *
 * maxDuration is 300s (Vercel allows it on every plan): on the 1st–~4th of a
 * month the catch-up branch re-extracts + recomputes the previous month while
 * its last flight days are still inside grace (lib/runNightly), on top of the
 * current month — the old 60s cap could not hold both. The full all-channel
 * mirror sync is the separate /api/cron/sync cron (06:00 UTC, 30min earlier) —
 * this pipeline only re-syncs #datasets itself as insurance, since cron timing
 * is best-effort.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runNightly } from "@/lib/runNightly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  try {
    const summary = await runNightly({ publish: true });
    return Response.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
