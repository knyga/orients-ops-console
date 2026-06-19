import { NextResponse } from "next/server";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEATURE = "field-verdict";

/**
 * GET /api/field-verdict — committed-only read path:
 *   ?periods=1    → { periods } the committed period keys (newest first)
 *   ?period=<key> → the committed verdict JSON
 *                   ({ period, runDate, graceWorkingDays, days, summary }), or 404
 *
 * There is intentionally NO live mode: the verdict needs the local Slack mirror
 * (#datasets) and the committed field-qa airborne report, which live behind the
 * CLI. Committed artifacts are produced by `npm run field-verdict -- --write`;
 * this route only reads them.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ periods: listPeriods(FEATURE) });
  }

  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json(
      { error: "Provide `period` or `periods`." },
      { status: 400 },
    );
  }
  if (!parsePeriodKey(period)) {
    return NextResponse.json(
      { error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." },
      { status: 400 },
    );
  }
  const report = readReportJson(FEATURE, period);
  if (!report) {
    return NextResponse.json(
      { error: `No committed report for ${period}.` },
      { status: 404 },
    );
  }
  return NextResponse.json(report);
}
