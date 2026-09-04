/** Pure CLI shaping for `field-evidence`. No server/Next imports; unit-tested. */
import { approverFor } from "../lib/approvers";
import { personByQuery, personForSlackId } from "../lib/people";

export interface EvidenceArgs { thread?: string; reply?: string; as?: string; write: boolean; list: boolean; start?: string; end?: string }

export function parseArgs(argv: string[]): EvidenceArgs {
  const a: EvidenceArgs = { write: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i], v = argv[i + 1];
    if (f === "--thread") { a.thread = v; i += 1; }
    else if (f === "--reply") { a.reply = v; i += 1; }
    else if (f === "--as") { a.as = v; i += 1; }
    else if (f === "--start") { a.start = v; i += 1; }
    else if (f === "--end") { a.end = v; i += 1; }
    else if (f === "--write") a.write = true;
    else if (f === "--list") a.list = true;
  }
  return a;
}

export function resolveActor(as: string | undefined): { userId: string; userName: string; role: "approver" | "pilot" } {
  if (!as) return { userId: "U_CLI", userName: "оператор (CLI)", role: "pilot" };
  const approver = approverFor(as);
  if (approver) return { userId: as, userName: approver.name, role: "approver" };
  const bySlack = /^U[A-Z0-9]{6,}$/.test(as) ? personForSlackId(as) : undefined;
  if (bySlack) return { userId: as, userName: bySlack.name, role: "pilot" };
  const found = personByQuery(as);
  // An ambiguous match is NOT silently resolved to one candidate — treat it like
  // "unknown" and let the operator be explicit (pass a Slack id or a fuller name).
  if ("person" in found) return { userId: found.person.slackId ?? "U_CLI", userName: found.person.name, role: "pilot" };
  return { userId: "U_CLI", userName: as, role: "pilot" };
}
