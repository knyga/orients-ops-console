/**
 * CLI twin of the Slack conversational agent (Phase B). Runs the SAME
 * lib/agent/loop.ts from the terminal — no Slack.
 *
 * Usage:
 *   npm run agent -- "what was done in jira today"
 *   npm run agent -- "create a ticket for Тарас: fix the export bug" --yes
 *
 * Read tools execute live. A write returns a confirm-first proposal: without
 * --yes the CLI prints the Ukrainian echo and stops; with --yes it applies the
 * proposal and prints the result. Needs ANTHROPIC_API_KEY + JIRA_* env; runs
 * under --conditions=react-server (see package.json) so lib/jira's server-only
 * import resolves to its empty module.
 */
import { runAgent } from "../lib/agent/loop";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");
  const prompt = argv.filter((a) => a !== "--yes").join(" ").trim();
  if (!prompt) {
    console.error('Usage: npm run agent -- "<your message>" [--yes]');
    process.exit(1);
  }

  const res = await runAgent(prompt);
  if (res.kind === "text" || res.kind === "error") {
    console.log(res.text);
    if (res.kind === "error") process.exit(1);
    return;
  }
  // proposal
  console.log(res.text);
  if (!yes) {
    console.log("\n(Re-run with --yes to apply.)");
    return;
  }
  const applied = await res.proposal!.apply();
  console.log(applied);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
