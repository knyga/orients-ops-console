/**
 * CLI: print the exact help text the bot replies with to a DM. The second
 * interface (per CLAUDE.md) for the DM /help feature — lets an operator verify
 * the wording from the terminal without going through Slack. Shares the same
 * pure `lib/dmHelp.ts` code path the webhook uses.
 *
 * Usage: npm run dm-help
 */
import { formatDmHelp } from "../lib/dmHelp";

console.log(formatDmHelp());
