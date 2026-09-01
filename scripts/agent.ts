/**
 * CLI twin of the Slack conversational agent (Phase B). Runs the SAME
 * lib/agent/loop.ts from the terminal — no Slack.
 *
 * Usage:
 *   npm run agent -- "what was done in jira today"
 *   npm run agent -- "create a ticket for Тарас: fix the export bug" --yes
 *   npm run agent -- --thread https://…/archives/C123…/p1712… "створи тікет з цього треду"
 *
 * Read tools execute live. A write returns a confirm-first proposal: without
 * --yes the CLI prints the Ukrainian echo and stops; with --yes it applies the
 * proposal and prints the result. --thread <channelId:ts | permalink> prepends
 * the live Slack thread's transcript — the same lib/agent/threadContext path the
 * Slack @mention surface uses (needs SLACK_TOKEN). Needs ANTHROPIC_API_KEY +
 * JIRA_* env; runs under --conditions=react-server (see package.json) so
 * lib/jira's server-only import resolves to its empty module.
 */
import { runAgent } from "../lib/agent/loop";
import { parseThreadRef, fetchThreadContext } from "../lib/agent/threadContext";
import { permalinkFor } from "../lib/slack";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");
  const threadIdx = argv.indexOf("--thread");
  const threadRef = threadIdx >= 0 ? argv[threadIdx + 1] : undefined;
  const rest = argv.filter(
    (a, i) => a !== "--yes" && a !== "--thread" && (threadIdx < 0 || i !== threadIdx + 1),
  );
  const prompt = rest.join(" ").trim();
  if (!prompt || (threadIdx >= 0 && !threadRef)) {
    console.error(
      'Usage: npm run agent -- "<your message>" [--thread <channelId:ts | permalink>] [--yes]',
    );
    process.exit(1);
  }

  let message = prompt;
  let sourceUrl: string | undefined;
  let channelId: string | undefined;
  let threadTs: string | undefined;
  if (threadRef) {
    const ref = parseThreadRef(threadRef);
    if (!ref) {
      console.error(
        `--thread: cannot parse "${threadRef}" (want C123:1234567890.123456 or a Slack permalink)`,
      );
      process.exit(1);
    }
    // Same deterministic source-link attach as the Slack surface: a ticket
    // created from a thread links back to it. channelId + threadTs also ride
    // along so a thread-scoped write (sprint_plan_build) targets the same
    // anchor the Slack surface would.
    sourceUrl = permalinkFor(ref.channelId, ref.threadTs);
    channelId = ref.channelId;
    threadTs = ref.threadTs;
    const ctx = await fetchThreadContext(ref.channelId, ref.threadTs);
    if (ctx) message = `${ctx}\n\n${prompt}`;
    else console.error("(thread has no messages — running without context)");
  }

  const res = await runAgent(message, { sourceUrl, channelId, threadTs });
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
