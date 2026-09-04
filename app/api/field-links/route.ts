import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { planRelinkForPeriod } from "@/lib/relinkDay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/field-links?period=<key> — the web twin of `npm run field-links`
 * (dry-run): per day, which cluster nodes exist (drone reminder, Звіт, verdict,
 * bonus reply, the bot's Звіт-thread reply, summary chunk) and the 🔗 edits a
 * relink would make. Read-only; never posts.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");
  if (!period) return NextResponse.json({ error: "Provide `period` (YYYY-MM or YYYY-MM-DD_YYYY-MM-DD)." }, { status: 400 });
  const parsed = parsePeriodKey(period);
  if (!parsed) return NextResponse.json({ error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." }, { status: 400 });
  try {
    const plan = await planRelinkForPeriod(parsed, null, "field-qa", true);
    return NextResponse.json({ period: parsed, channel: "field-qa", days: plan.days });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
