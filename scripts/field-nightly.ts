/**
 * CLI: run the full autonomous field pipeline (sync → extract → verdict →
 * publish) locally — DRY-RUN BY DEFAULT. Mirrors /api/cron/field-nightly via the
 * shared lib/runNightly, so CLI and cron cannot diverge.
 *
 *   npm run field-nightly                        # dry-run over the catch-up window
 *   npm run field-nightly -- --today 2026-07-02  # dry-run pinned to a date
 *   npm run field-nightly -- --publish           # ACTUALLY sync/extract/verdict/publish to #field-qa
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { runNightly } from "../lib/runNightly";

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
  const summary = await runNightly({
    publish: args.publish,
    today: args.today,
    onLog: (m) => process.stderr.write(`${m}\n`),
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.publish) {
    process.stderr.write(
      "field-nightly: DRY RUN — nothing was published. Re-run with --publish to post to #field-qa.\n",
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`field-nightly: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
