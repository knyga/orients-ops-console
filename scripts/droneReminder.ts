/**
 * CLI: the daily drone-count reminder — DRY-RUN BY DEFAULT. Mirrors
 * /api/cron/drone-reminder via the shared lib/droneReminder, so CLI and cron
 * cannot diverge.
 *
 *   npm run drone-reminder                        # dry-run: print who'd be tagged + the text
 *   npm run drone-reminder -- --today 2026-08-03  # dry-run pinned to a date
 *   npm run drone-reminder -- --publish           # ACTUALLY post to #field-qa
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { runDroneReminder } from "../lib/droneReminder";

function parseArgs(argv: string[]): { publish: boolean; today?: string } {
  const out: { publish: boolean; today?: string } = { publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--publish") out.publish = true;
    else if (argv[i] === "--today") {
      out.today = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }
  const args = parseArgs(process.argv.slice(2));
  const result = await runDroneReminder({
    publish: args.publish,
    today: args.today,
    trigger: "cli",
    onLog: (m) => process.stderr.write(`${m}\n`),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!args.publish && result.text) {
    process.stderr.write("drone-reminder: DRY RUN — nothing was posted. Re-run with --publish to post to #field-qa.\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`drone-reminder: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
