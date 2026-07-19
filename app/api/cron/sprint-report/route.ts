/**
 * Vercel Cron: Sunday ~23:00 Kyiv — measure the frozen baseline's completion and
 * post the "Completed" report (per-assignee + rate + stuck-across-sprints) to
 * #general. Guarded by CRON_SECRET. Scheduled in vercel.json as `0 20 * * 0`
 * (20:00 UTC = 23:00 Kyiv EEST): set an hour early so even a +59-min slip stays
 * before Sunday midnight Kyiv. No frozen baseline for the active sprint → skips
 * (can't measure completion without the Monday snapshot).
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runSprintReport } from "@/lib/runSprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const result = await runSprintReport({ publish: true, channelName: "general", trigger: "cron" });
  const ok = result.status === "ok";
  return Response.json({ ok, ...result }, { status: 200 });
}
