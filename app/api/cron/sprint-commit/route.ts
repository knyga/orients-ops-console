/**
 * Vercel Cron: Monday ~21:00 Kyiv — freeze the active sprint's committed baseline
 * and post the "Committed" list to #general. Guarded by CRON_SECRET. Scheduled in
 * vercel.json as `0 18 * * 1` (18:00 UTC ≈ 21:00 Kyiv EEST; the cron pins the
 * weekday, DST only shifts the hour within Monday). Idempotent: the Slack send is
 * deduped by sprint slug, so a ±59-min re-fire posts once.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runSprintCommit } from "@/lib/runSprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const result = await runSprintCommit({ publish: true, channelName: "general", trigger: "cron" });
  const ok = result.status === "ok";
  return Response.json({ ok, ...result }, { status: ok ? 200 : 200 });
}
