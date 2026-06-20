import { NextResponse } from "next/server";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

// Reads committed artifacts only; never calls Slack/Claude (extraction is the
// CLI's job — it costs LLM tokens and must be reviewed before use).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEATURE = "field-qa";

/**
 * GET /api/field-qa
 *   ?periods=1    → { periods } committed period keys (newest first)
 *   ?period=<key> → the committed FieldQaReport JSON, or 404
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ periods: await listPeriods(FEATURE) });
  }

  const period = searchParams.get("period");
  if (period) {
    if (!parsePeriodKey(period)) {
      return NextResponse.json(
        { error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." },
        { status: 400 },
      );
    }
    const report = await readReportJson(FEATURE, period);
    if (!report) {
      return NextResponse.json({ error: `No committed report for ${period}.` }, { status: 404 });
    }
    return NextResponse.json(report);
  }

  return NextResponse.json(
    { error: "Provide `period` or `periods`." },
    { status: 400 },
  );
}
