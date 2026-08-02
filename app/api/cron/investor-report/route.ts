/**
 * Vercel Cron: Tuesday 06:00 UTC (≈09:00 Kyiv summer / 08:00 winter — the same
 * fixed-UTC compromise as the other crons) — draft the weekly investor report
 * for the previous Mon–Sun week and post it to #general. The post is an
 * INTERNAL DRAFT the team edits before forwarding to investors. Guarded by
 * CRON_SECRET. Any data-stage failure skips the post and DMs the operator;
 * a re-fire dedups on the `investor:<week>` outbound key.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runInvestor } from "@/lib/runInvestor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const result = await runInvestor({ publish: true, channelName: "general", trigger: "cron" });
  return Response.json({ ok: result.status === "ok", ...result }, { status: 200 });
}
