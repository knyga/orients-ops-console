/**
 * CLI: sprint completion — DRY-RUN BY DEFAULT. The terminal twin of the two
 * Vercel cron routes; both call lib/runSprint.
 *
 * Usage:
 *   npm run sprint -- commit                                  # dry-run: freeze baseline + print Committed post
 *   npm run sprint -- report                                  # dry-run: measure completion + print Completed post
 *   npm run sprint -- commit --publish --channel general      # ACTUALLY POST (needs chat:write)
 *   npm run sprint -- report --publish --channel general      # ACTUALLY POST
 *   npm run sprint -- commit --sprint 42                      # override the auto-picked active sprint by id
 *
 * Output: the short ANCHOR post first, then each thread reply (the per-issue
 * detail) under a `--- thread N/M ---` separator — exactly what gets posted.
 *
 * Safety:
 *  - Dry-run is the default; a real post requires the explicit `--publish` flag.
 *  - `--publish` REQUIRES `--channel <name>` (a tracked channel) — no default target.
 *  - `commit` freezes the active sprint's issue set (the completion denominator);
 *    `report` needs that frozen baseline to exist first.
 *
 * Runs under `--conditions=react-server` so the server-only Jira/Slack imports resolve.
 */
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { runSprintCommit, runSprintReport } from "../lib/runSprint";

interface Args {
  mode: "commit" | "report";
  publish: boolean;
  channel?: string;
  sprintId?: number;
}

function parseArgs(argv: string[]): Args {
  const mode = argv[0];
  if (mode !== "commit" && mode !== "report") {
    process.stderr.write("sprint: first argument must be `commit` or `report`.\n");
    process.exit(1);
  }
  const args: Args = { mode, publish: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") args.publish = true;
    else if (a === "--channel") args.channel = argv[++i];
    else if (a === "--sprint") args.sprintId = Number(argv[++i]);
  }
  return args;
}

/** Print the anchor post, then each threaded detail message, as posted. */
function printPost(anchor: string, details: string[]): void {
  console.log(anchor);
  details.forEach((text, i) => {
    console.log(`\n--- thread ${i + 1}/${details.length} ---`);
    console.log(text);
  });
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));

  if (args.publish) {
    if (!args.channel) {
      process.stderr.write("sprint: --publish requires --channel <name> (no default target).\n");
      process.exit(1);
    }
    if (!TRACKED_CHANNELS.some((c) => c.name === args.channel)) {
      process.stderr.write(
        `sprint: unknown channel "${args.channel}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).\n`,
      );
      process.exit(1);
    }
  }

  const opts = {
    publish: args.publish,
    channelName: args.channel,
    sprintId: args.sprintId,
    trigger: "cli" as const,
  };

  if (args.mode === "commit") {
    const r = await runSprintCommit(opts);
    if (r.status === "no-active-sprint") {
      process.stderr.write("sprint: no active sprint on the board — nothing to freeze.\n");
      process.exit(1);
    }
    process.stderr.write(
      `sprint commit: ${r.sprintName} — froze ${r.count} issue(s)${r.posted ? ` and posted to #${args.channel}` : " (dry-run, nothing posted)"}.\n`,
    );
    printPost(r.anchor, r.details);
    return;
  }

  const r = await runSprintReport(opts);
  if (r.status === "no-active-sprint") {
    process.stderr.write("sprint: no active sprint on the board — nothing to report.\n");
    process.exit(1);
  }
  if (r.status === "no-baseline") {
    process.stderr.write(
      `sprint report: no frozen baseline for ${r.sprintName} (slug ${r.slug}) — run \`npm run sprint -- commit\` first (normally the Monday job).\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `sprint report: ${r.sprintName} — ${r.completed}/${r.committed} (${r.rate}%), ${r.stuck} stuck${r.posted ? ` — posted to #${args.channel}` : " (dry-run, nothing posted)"}.\n`,
  );
  printPost(r.anchor, r.details);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sprint: ${message}\n`);
  process.exit(1);
});
