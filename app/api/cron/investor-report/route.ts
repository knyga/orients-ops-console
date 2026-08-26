/**
 * Vercel Cron: Monday 07:00 UTC (≈10:00 Kyiv summer / 09:00 winter — the same
 * fixed-UTC compromise as the other crons; an hour after the Monday sprint
 * report, whose completion record it reads) — draft the weekly investor report
 * for the previous Mon–Sun week and post it to #general. The post is an
 * INTERNAL DRAFT the team edits before forwarding to investors. Guarded by
 * CRON_SECRET. Any data-stage failure skips the post and DMs the operator;
 * a re-fire dedups on the `investor:<week>` outbound key.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runInvestor } from "@/lib/runInvestor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 (the current plan-default ceiling, up from the old 60s Hobby cap): the
// run now fetches the week's merged-PR contexts (repos + PRs + diffs,
// sequential) AND gives the Opus summary call up to 240s to digest the
// ~120k-char git grounding — 60s starves that call into the fallback.
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const result = await runInvestor({ publish: true, channelName: "general", trigger: "cron" });
  return Response.json({ ok: result.status === "ok", ...result }, { status: 200 });
}
