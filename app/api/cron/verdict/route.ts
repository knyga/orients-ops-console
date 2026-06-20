/**
 * Vercel Cron: recompute the current Europe/Kyiv month's field-day verdicts and
 * persist the committed reports/field-verdict/<period> (Postgres), so the
 * dashboard and CLIs always see an up-to-date verdict without a manual run. Same
 * computation as the `field-verdict` CLI (lib/computeVerdicts). Guarded by
 * CRON_SECRET. Scheduled in vercel.json (after the sync cron).
 *
 * Outward posting (publishing verdicts to Slack) is deliberately NOT done here —
 * it stays the explicit, dry-run-by-default `field-publish` flow. This cron only
 * recomputes + persists.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { computeVerdicts, todayInFieldTz } from "@/lib/computeVerdicts";
import { periodKey } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });

  const today = todayInFieldTz();
  const period = { start: `${today.slice(0, 7)}-01`, end: today };
  const report = await computeVerdicts(period, { today, write: true });

  return Response.json({ ok: true, period: periodKey(period), summary: report.summary });
}
