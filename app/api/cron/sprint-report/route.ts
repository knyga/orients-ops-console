/**
 * Vercel Cron: Monday ~09:00 Kyiv — measure the frozen baseline's completion and
 * post the "Completed" report (per-assignee + rate + stuck-across-sprints) to
 * #general. Guarded by CRON_SECRET. Scheduled in vercel.json as `0 6 * * 1`
 * (06:00 UTC ≈ 09:00 Kyiv EEST / 08:00 EET — the same fixed-UTC compromise as
 * every other cron; the weekday is pinned, DST only shifts the hour within
 * Monday). Runs BEFORE the Tuesday `sprint-commit` freezes the next baseline,
 * and an hour before the Monday 10:00 investor report that reads the completion
 * record it writes. NOTE: it reports on the board's ACTIVE sprint, so the
 * finished sprint must still be open in Jira on Monday morning — completing it
 * before 09:00 makes the new sprint active, which has no frozen baseline and
 * skips the report.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runSprintReport } from "@/lib/runSprint";
import { alertApprovers } from "@/lib/opsAlert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  try {
    const result = await runSprintReport({ publish: true, channelName: "general", trigger: "cron" });
    const ok = result.status === "ok";
    return Response.json({ ok, ...result }, { status: 200 });
  } catch (error) {
    // A hard failure (e.g. a dead Jira token) means no post AND no visible
    // signal — DM the approvers instead of failing silently into the cron logs.
    await alertApprovers(error, "cron-sprint-report", "cron");
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
