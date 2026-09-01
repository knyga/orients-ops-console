/**
 * Vercel Cron: the daily drone-count reminder. At ~09:00 Kyiv (0 6 * * * UTC —
 * 08:00 in winter, the same fixed-UTC compromise as the other crons) it tags
 * the drone owners who have not yet submitted their own count for today in
 * #field-qa; all submitted → posts nothing. Guarded by CRON_SECRET; idempotent
 * via the `drone-reminder:<date>` outbound key. Scheduled in vercel.json.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runDroneReminder } from "@/lib/droneReminder";
import { alertApprovers } from "@/lib/opsAlert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  try {
    const result = await runDroneReminder({ publish: true, trigger: "cron" });
    return Response.json({ ok: true, result });
  } catch (error) {
    // A hard failure would otherwise only reach the cron logs — DM the approvers.
    await alertApprovers(error, "cron-drone-reminder", "cron");
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
