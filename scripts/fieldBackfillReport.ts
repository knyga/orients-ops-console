/**
 * Pure presentation for the field-backfill CLI (scripts/field-backfill.ts):
 * renders the dry-run report from a backfill plan. No DB/Slack/fs — unit-tested.
 * The shell handles the period resolution, DB reads, and chat.update writes.
 */
import type { Period } from "./fieldPublishReport";
import type { BackfillItem } from "../lib/backfillPublished";

/** The dry-run text: what would change, what is skipped (and why), nothing sent. */
export function formatDryRun(
  plan: BackfillItem[],
  channel: string | undefined,
  period: Period,
): string {
  const updates = plan.filter((p) => p.action === "update");
  const alreadyCurrent = plan.filter((p) => p.reason === "already-current");
  const overridden = plan.filter((p) => p.reason === "overridden");
  const noVerdict = plan.filter((p) => p.reason === "no-verdict");
  const target = channel ? `#${channel}` : "(no channel — pass --channel <name>)";

  const lines: string[] = [];
  lines.push(
    `DRY RUN — would update ${updates.length} message(s) in ${target}   [${period.start} … ${period.end}]`,
  );
  lines.push(
    `(${alreadyCurrent.length} already current; ${overridden.length} overridden, skipped; ${noVerdict.length} no verdict, skipped)`,
  );
  lines.push("");

  for (const u of updates) {
    lines.push(`  ${u.date}:`);
    lines.push(`    old: ${u.oldText}`);
    lines.push(`    new: ${u.newText}`);
  }

  if (overridden.length) {
    lines.push("");
    lines.push("  Skipped (overridden — would clobber the struck amendment; handle manually):");
    for (const o of overridden) lines.push(`    ${o.date}`);
  }
  if (noVerdict.length) {
    lines.push("");
    lines.push("  Skipped (no verdict in the report for the day):");
    for (const n of noVerdict) lines.push(`    ${n.date}`);
  }

  lines.push("");
  lines.push(
    "No messages were sent. Re-run with `--publish --channel <name>` to update for real (needs chat:write).",
  );
  return lines.join("\n");
}
