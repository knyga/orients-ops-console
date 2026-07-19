import { NextResponse } from "next/server";
import { listSprintSlugs, readSprint } from "@/lib/sprintStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sprint?sprints=1        → { slugs: string[] } (newest first)
 * GET /api/sprint?slug=<slug>      → the stored SprintRecord (404 when absent)
 *
 * Read-only view of the committed sprint artifacts (feature "sprint" in the
 * reports table). The web never writes — freezing/enriching is the CLI/cron's job.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("sprints")) {
    return NextResponse.json({ slugs: await listSprintSlugs() });
  }

  const slug = searchParams.get("slug");
  if (!slug) {
    return NextResponse.json(
      { error: "Provide `slug=<sprint-slug>` or `sprints=1` to list." },
      { status: 400 },
    );
  }
  const record = await readSprint(slug);
  if (!record) {
    return NextResponse.json({ error: `No committed sprint "${slug}".` }, { status: 404 });
  }
  return NextResponse.json(record);
}
