import { NextResponse } from "next/server";
import { readManifest, readState } from "@/lib/driveStore";
import { fetchModifiedTime, DriveError } from "@/lib/drive";

// Reads committed sidecars; ?check=1 hits Drive live. Never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/drive
 *   (default)  → { sources, state } from the committed manifest + state (no network)
 *   ?check=1   → adds { check: [{ id, stale, modifiedTime }] } via a live
 *                modifiedTime compare (the only network path; mirrors other
 *                features' refresh). Pulling/writing stays the CLI's job.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  let manifest;
  try {
    manifest = readManifest();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unreadable manifest.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  const state = readState();

  if (!searchParams.get("check")) {
    return NextResponse.json({ sources: manifest.sources, state });
  }

  try {
    const check = await Promise.all(
      manifest.sources.map(async (s) => {
        const modifiedTime = await fetchModifiedTime(s);
        const known = state[s.id]?.modifiedTime;
        return { id: s.id, stale: !known || modifiedTime > known, modifiedTime };
      }),
    );
    return NextResponse.json({ sources: manifest.sources, state, check });
  } catch (error) {
    if (error instanceof DriveError) {
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
