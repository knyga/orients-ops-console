import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { readProposalsInWindow } from "@/lib/proposals";
import { readRosterCorrections } from "@/lib/rosterCorrections";
import { readResolutions } from "@/lib/resolutions";
import { readAirborneOverrides } from "@/lib/airborneOverrides";
import { mergeCorrections } from "@/lib/instructionsView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/instructions?period=<key> — read-only view of the confirm-first
 * approver-instruction feature for a period: PROPOSED/settled proposals + the
 * applied corrections (crew/eligibility/day/dataset/video/airborne). Backed
 * directly by our own DB (no committed snapshot), like /api/sent.
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

  const [proposals, rosters, resolutions, airbornes] = await Promise.all([
    readProposalsInWindow(parsed.start, parsed.end),
    readRosterCorrections(),
    readResolutions(),
    readAirborneOverrides(),
  ]);
  const corrections = mergeCorrections(rosters, resolutions, airbornes, parsed.start, parsed.end);

  return NextResponse.json({
    period: parsed,
    pending: proposals.filter((p) => p.state === "PROPOSED"),
    proposals,
    corrections,
  });
}
