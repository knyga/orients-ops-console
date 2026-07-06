import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { readLossRecords } from "@/lib/lossStore";
import { readReportJson, periodKey } from "@/lib/reports";
import { buildLossReport } from "@/scripts/fieldLossReport";
import type { BonusReport } from "@/lib/fieldBonus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/field-loss?period=<key> — the drone-loss ledger's effective view for
 * a period: losses, the unrecovered counter vs the >3 team cutoff, and crew
 * penalty exposure from the committed field-bonus report. Backed directly by
 * our own DB (no committed snapshot), like /api/instructions.
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
  const [rows, bonus] = await Promise.all([
    readLossRecords(),
    readReportJson<BonusReport>("field-bonus", periodKey(parsed)),
  ]);
  return NextResponse.json(buildLossReport(rows, parsed, bonus?.penalties ?? []));
}
