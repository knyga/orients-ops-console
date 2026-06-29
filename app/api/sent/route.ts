import { NextResponse } from "next/server";
import { readOutbound, readOutboundPeriods } from "@/lib/outbound";
import { parsePeriodKey } from "@/lib/period";
import { summarizeSent, toSentView } from "@/lib/sentLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sent — read-only audit log of the bot's outbound Slack messages.
 *   ?periods=1    → { periods } the months (UTC, newest first) that have rows
 *   ?period=<key> → { period, count, summary, messages } for that period
 *
 * Backed directly by the canonical outbound_messages table (no committed
 * snapshot — unlike the external-source features, this data already lives in our
 * own DB).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ periods: await readOutboundPeriods() });
  }

  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json({ error: "Provide `period` or `periods`." }, { status: 400 });
  }
  const parsed = parsePeriodKey(period);
  if (!parsed) {
    return NextResponse.json(
      { error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." },
      { status: 400 },
    );
  }

  const rows = toSentView(await readOutbound(parsed));
  return NextResponse.json({
    period: parsed,
    count: rows.length,
    summary: summarizeSent(rows),
    messages: rows,
  });
}
