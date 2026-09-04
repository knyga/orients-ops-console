/**
 * CLI twin of the agent's `slack_read_link` tool: resolve one or more Slack message
 * permalinks into readable text (the message, or its whole thread when threaded).
 *
 * Usage:
 *   npm run slack-link -- https://orientsai.slack.com/archives/C08GY2NKF9D/p1788531440845259
 *   npm run slack-link -- <url> [<url> …] [--format json]
 *
 * Read-only. Needs SLACK_TOKEN (and the bot present in the channel). Mirrors
 * `GET /api/slack-link?url=<permalink>`. Runs under --conditions=react-server so
 * lib/slack's server-only import resolves to its empty module.
 */
import { resolveSlackLink, SlackLinkError } from "../lib/agent/slackLinkContext";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const argv = process.argv.slice(2);
  const fmtIdx = argv.indexOf("--format");
  const format = fmtIdx >= 0 ? argv[fmtIdx + 1] : "text";
  const urls = argv.filter((a, i) => a !== "--format" && (fmtIdx < 0 || i !== fmtIdx + 1));
  if (urls.length === 0) {
    console.error("Usage: npm run slack-link -- <slack permalink> [<permalink> …] [--format json]");
    process.exit(1);
  }
  const out: unknown[] = [];
  let failed = false;
  for (const url of urls) {
    try {
      const { ref, thread, rendered } = await resolveSlackLink(url);
      if (format === "json") out.push({ url: ref.url, channelId: ref.channelId, ts: ref.ts, threadTs: ref.threadTs, messages: thread.messages, rendered });
      else console.log(`${urls.length > 1 ? `${url}\n` : ""}${rendered}${urls.length > 1 ? "\n" : ""}`);
    } catch (err) {
      failed = true;
      const message = err instanceof SlackLinkError ? err.message : err instanceof Error ? err.message : String(err);
      if (format === "json") out.push({ url, error: message });
      else console.error(`${url}: ${message}`);
    }
  }
  if (format === "json") console.log(JSON.stringify(urls.length === 1 ? out[0] : out, null, 2));
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
