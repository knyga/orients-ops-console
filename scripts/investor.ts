/**
 * CLI: weekly investor report — DRY-RUN BY DEFAULT. The terminal twin of the
 * /api/cron/investor-report Vercel cron; both call lib/runInvestor.
 *
 * Usage:
 *   npm run investor                                     # dry-run: compute + store + print the Ukrainian post
 *   npm run investor -- --today 2026-08-04               # dry-run for another week's Tuesday
 *   npm run investor -- --format json                    # dry-run, print the run result (status/key/message/posted/summarySource) as JSON
 *   npm run investor -- --publish --channel general      # ACTUALLY POST to #general (needs chat:write)
 *
 * Safety:
 *  - Dry-run is the default; a real post requires the explicit `--publish` flag.
 *  - `--publish` REQUIRES `--channel <name>` (a tracked channel) — no default target.
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { runInvestor } from "../lib/runInvestor";

interface Args {
  publish: boolean;
  channel?: string;
  today?: string;
  format: "text" | "json";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { publish: false, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") args.publish = true;
    else if (a === "--channel") args.channel = argv[++i];
    else if (a === "--today") args.today = argv[++i];
    else if (a === "--format") args.format = argv[++i] === "json" ? "json" : "text";
  }
  return args;
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));

  if (args.publish) {
    if (!args.channel) {
      process.stderr.write("investor: --publish requires --channel <name> (no default target).\n");
      process.exit(1);
    }
    if (!TRACKED_CHANNELS.some((c) => c.name === args.channel)) {
      process.stderr.write(
        `investor: unknown channel "${args.channel}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).\n`,
      );
      process.exit(1);
    }
  }

  const result = await runInvestor({
    publish: args.publish,
    channelName: args.channel,
    today: args.today,
    trigger: "cli",
  });

  if (result.status === "failed") {
    process.stderr.write(`investor: FAILED at ${result.stage}: ${result.reason}\n`);
    process.exit(1);
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const git = result.gitContext
    ? result.gitContext.error
      ? `git: unavailable (${result.gitContext.error})`
      : `git: ${result.gitContext.included.length} PRs, ${Math.round(result.gitContext.totalChars / 1000)}k chars${result.gitContext.truncated ? ", truncated" : ""}`
    : "git: —";
  process.stdout.write(
    `--- week ${result.key} (summary: ${result.summarySource}; ${git}) ---\n\n`,
  );
  process.stdout.write(`${result.message}\n\n`);
  process.stdout.write(
    result.posted ? "POSTED.\n" : "DRY-RUN — nothing posted (use --publish --channel <name>).\n",
  );
}

main().catch((err) => {
  process.stderr.write(`investor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
