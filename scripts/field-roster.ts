/**
 * CLI: ingest AUTHORIZED approvers' in-thread roster corrections to published
 * verdicts — DRY-RUN BY DEFAULT. For each posted verdict it reads the threaded
 * replies from the Slack mirror, keeps only approver replies (lib/approvers),
 * classifies each as a roster/eligibility correction via Claude, resolves names
 * via the alias map, replays them onto the parsed "Звіт" roster, and (with
 * --write) edits the crew suffix + posts a Ukrainian ack and records the
 * correction. The next field-verdict + field-bonus runs reflect it.
 *
 * Usage:
 *   npm run field-roster -- --start 2026-06-01 --end 2026-06-19          # dry-run
 *   npm run field-roster -- --start … --end … --write                   # apply
 * Defaults to the current Europe/Kyiv month. Run `npm run slack-sync` first.
 * Classification needs ANTHROPIC_API_KEY. Runs under --conditions=react-server.
 */
import { classifyRosterCorrection } from "../lib/rosterCorrectionClassify";
import { approverFor } from "../lib/approvers";
import { applyRosterDecision } from "../lib/applyRosterCorrection";
import { readChannelMessages } from "../lib/slackMirror";
import { readPublished } from "../lib/published";
import { parseMonth } from "../lib/fieldReports";
import { readAliases, mergeAliases } from "../lib/rosterAliases";
import { SEED_ALIASES, resolveInitial } from "../lib/fieldRoster";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import {
  decideRosterCorrection,
  parseArgs,
  resolvePeriod,
  type ClassifiedRosterReply,
  type Period,
} from "./fieldRosterReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Resolve initials/short tokens to canonical names (same map as parseZvit).
function resolveNames(tokens: string[] | undefined, aliases: Record<string, string>): string[] | undefined {
  if (!tokens) return undefined;
  return tokens.map((t) => {
    const r = resolveInitial(t, aliases);
    return "name" in r ? r.name : r.unknown;
  });
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  const published = await readPublished(period);
  const entries = Object.values(published);
  if (entries.length === 0) {
    process.stderr.write(`field-roster: no published verdicts for ${period.start}…${period.end} (run \`npm run field-publish --publish\` first).\n`);
    return;
  }

  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const readWindow = { start: period.start, end: today > period.end ? today : period.end };

  // Parsed baseline crew per flight day, from the #field-qa "Звіт" reports.
  const fieldQaMessages = (await readChannelMessages("field-qa", readWindow)).filter((m) => !m.deleted);
  const parsedByDate = new Map(parseMonth(fieldQaMessages, aliases).map((r) => [r.flightDate, r.roster]));

  let applied = 0;
  for (const entry of entries) {
    const replies = (await readChannelMessages(entry.channel, readWindow)).filter(
      (m) => m.thread_ts === entry.ts && m.ts !== entry.ts && !m.deleted,
    );
    if (replies.length === 0) continue;

    const classified: ClassifiedRosterReply[] = [];
    for (const r of replies) {
      const approver = approverFor(r.authorId);
      if (!approver) { console.log(`• ${entry.date} — ignoring reply from non-approver ${r.author}.`); continue; }
      const c = await classifyRosterCorrection(entry.text, r.text);
      const resolved = {
        ...c,
        roster: resolveNames(c.roster, aliases),
        add: resolveNames(c.add, aliases),
        remove: resolveNames(c.remove, aliases),
        counted: resolveNames(c.counted, aliases),
        notCounted: resolveNames(c.notCounted, aliases),
      };
      classified.push({ classification: resolved, by: approver.name, permalink: r.permalink, ts: r.ts });
      console.log(`• ${entry.date} ← ${approver.name}: "${r.text.slice(0, 80)}" → ${c.kind}`);
    }

    const outcome = decideRosterCorrection(parsedByDate.get(entry.date) ?? [], classified);
    if (!outcome) continue;

    console.log(`  ⇒ ${args.write ? "applying" : "would apply"}: ${entry.date} → crew [${outcome.roster.join(", ")}]` +
      (Object.keys(outcome.eligibility).length ? ` elig ${JSON.stringify(outcome.eligibility)}` : "") + ` by ${outcome.by}`);

    if (args.write) {
      const result = await applyRosterDecision({ entry, period, outcome, trigger: "cli" });
      if (result.applied) { process.stderr.write(`field-roster: amended crew for ${entry.date} in #${entry.channel}.\n`); applied += 1; }
      else process.stderr.write(`field-roster: ${entry.date} — recorded correction but crew suffix unchanged / channel not tracked.\n`);
    }
  }

  if (args.write) process.stderr.write(`field-roster: applied ${applied} correction(s). Re-run \`npm run field-verdict -- --write\` and \`npm run field-bonus\` to reflect them.\n`);
  else process.stderr.write("field-roster: DRY RUN — nothing written. Re-run with --write to apply.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-roster: ${message}\n`);
  process.exit(1);
});
