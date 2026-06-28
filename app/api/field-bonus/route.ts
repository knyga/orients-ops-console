import { NextResponse } from "next/server";
import { readReportJson, listPeriods } from "@/lib/reports";
import { parsePeriodKey } from "@/lib/period";
import { computeBonusReport } from "@/lib/computeBonuses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEATURE = "field-bonus";

/**
 * GET /api/field-bonus — hybrid read path:
 *   ?periods=1            → { periods } the committed period keys (newest first)
 *   ?period=<key>         → the committed lossless report JSON
 *                           ({ period, people, total, teamZeroed, flags }), or 404
 *   ?start=&end=[&refresh]→ live computation via field-qa + Vimeo + Claude (the
 *                           only network path)
 *
 * Committing artifacts is the CLI's job (`npm run field-bonus -- --write`); this
 * route reads committed reports and computes live on demand.
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
      return NextResponse.json(
        { error: `No committed report for ${period}.` },
        { status: 404 },
      );
    }
    return NextResponse.json(report);
  }

  // Live mode: ?start=&end= (with optional ?refresh=1).
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Provide `period`, `periods`, or both `start` and `end`." },
      { status: 400 },
    );
  }

  try {
    const periodObj = { start, end };
    const report = await computeBonusReport(periodObj);
    return NextResponse.json(report);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
