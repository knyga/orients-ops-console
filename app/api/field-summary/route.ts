import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { assembleSummaryDays } from "@/lib/fieldSummaryPost";
import { buildMonthSummary, summaryCounts } from "@/lib/fieldMonthSummary";
import { todayInFieldTz } from "@/lib/computeVerdicts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/field-summary?period=<key> — the web twin of `npm run field-summary`
 * and the agent's `field_summary_post`: the exact Ukrainian anchor + thread
 * texts the bot would post for the period (built from the same committed
 * reports via lib/fieldSummaryPost), plus the structured per-day rows and
 * counts. Read-only; never posts.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json({ error: "Provide `period` (YYYY-MM or YYYY-MM-DD_YYYY-MM-DD)." }, { status: 400 });
  }
  const parsed = parsePeriodKey(period);
  if (!parsed) {
    return NextResponse.json({ error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." }, { status: 400 });
  }
  try {
    const today = todayInFieldTz();
    const days = await assembleSummaryDays(parsed);
    const { anchor, details } = buildMonthSummary(parsed, today, days);
    return NextResponse.json({ period: parsed, today, counts: summaryCounts(days), anchor, details, days });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
