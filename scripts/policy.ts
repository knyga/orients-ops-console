/**
 * CLI: fetch tracked Slack channels for a window, build the deterministic policy
 * schedule, and print/persist it.
 *
 * Usage:
 *   npm run policy -- --start 2026-05-01 --end 2026-05-31 [--format table]
 *   npm run policy -- --start … --end … --dump-occurrences   (JSON for the classifier subagents; exits)
 *   npm run policy -- --start … --end … --verdicts-file v.json   (merge verdicts + write artifacts)
 * Defaults to the current calendar month (UTC) when bounds are omitted.
 *
 * `--write` persists reports/policy/<period>.{json,csv}. `--verdicts-file` reads
 * a JSON object (occurrenceId → {verdict, rationale}) produced by Claude Code
 * sonnet subagents and implies `--write`. `--dump-occurrences` prints the
 * NEEDS_REVIEW occurrences (with candidate evidence + obligation description)
 * those subagents consume, then exits — no write.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` import in ../lib/slack resolves to its empty module.
 */
import { readFileSync } from "node:fs";
import { fetchMessages } from "../lib/slack";
import { buildSchedule, unconfiguredObligations } from "../lib/policySchedule";
import { OBLIGATIONS } from "../lib/policyRegistry";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { writeReport } from "../lib/reports";
import {
  applyVerdicts,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type VerdictMap,
} from "./policyReport";

/** Today's date (YYYY-MM-DD) in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadVerdictsFile(path: string): VerdictMap {
  return JSON.parse(readFileSync(path, "utf8")) as VerdictMap;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayUtc());

  // Loud guard: an obligation pointing at an untracked channel can never gather
  // evidence, so its occurrences would silently read MISSING/PENDING. Surface it.
  const unconfigured = unconfiguredObligations(
    OBLIGATIONS,
    TRACKED_CHANNELS.map((c) => c.name),
  );
  if (unconfigured.length > 0) {
    process.stderr.write(
      `policy: WARNING — ${unconfigured.length} obligation(s) reference channels not in lib/slackChannels; ` +
        `their occurrences are NOT real (no message can match):\n` +
        unconfigured.map((u) => `  - ${u.obligationId} → #${u.channel}\n`).join(""),
    );
  }

  const messages = await fetchMessages(period);
  const schedule = buildSchedule(OBLIGATIONS, messages, period, todayUtc());

  // --dump-occurrences: emit the occurrences needing a verdict (with evidence +
  // obligation description) for the classifier subagents, then exit.
  if (args.dumpOccurrences) {
    const byId = new Map(OBLIGATIONS.map((o) => [o.id, o]));
    const dump = schedule.occurrences
      .filter((o) => o.status === "NEEDS_REVIEW")
      .map((o) => ({ ...o, description: byId.get(o.obligationId)?.description ?? "" }));
    console.log(JSON.stringify(dump, null, 2));
    return;
  }

  const verdicts = args.verdictsFile ? loadVerdictsFile(args.verdictsFile) : undefined;
  if (verdicts) {
    process.stderr.write(
      `policy: loaded ${Object.keys(verdicts).length} verdicts from ${args.verdictsFile}\n`,
    );
  }
  const report = applyVerdicts(schedule, todayUtc(), verdicts);

  if (args.format === "table") {
    console.log(formatTable(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (args.write || args.verdictsFile) {
    const { jsonPath, csvPath } = writeReport("policy", period, {
      json: JSON.stringify(report, null, 2),
      csv: toCsv(report),
    });
    process.stderr.write(
      `policy: wrote ${jsonPath} and ${csvPath} (${report.occurrences.length} occurrences, ${report.skipped.length} skipped)\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`policy: ${message}\n`);
  process.exit(1);
});
