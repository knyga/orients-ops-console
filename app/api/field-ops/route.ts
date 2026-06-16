import { NextResponse } from "next/server";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEATURE = "field-ops";

/**
 * GET /api/field-ops — committed-only read path:
 *   ?periods=1    → { periods } the committed period keys (newest first)
 *   ?period=<key> → the committed reconciliation JSON
 *                   ({ period, daily, summary, flightInputPath }), or 404
 *
 * There is intentionally NO live mode here: live reconciliation needs the
 * ephemeral pasted flight hours, which stays a pure client computation against
 * `/api/vimeo?refresh=1`. Committed artifacts are produced by the CLI
 * (`npm run fieldops -- --write`); this route only reads them.
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
