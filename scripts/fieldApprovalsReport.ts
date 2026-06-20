/**
 * Pure CLI shaping for the approver-override command (S7): arg parsing, period
 * resolution, and the decision that turns an authorized approver's classified
 * thread replies into a single outcome. No server/Next/fs imports — unit-tested.
 */
import type { ApprovalClassification } from "../lib/approvalClassifyPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  start: string;
  end: string;
}

export interface ApprovalsArgs {
  start?: string;
  end?: string;
  /** Apply outcomes (write resolutions). Default false = dry-run. */
  write: boolean;
}

/** An approver's reply, already classified, with provenance. */
export interface ApproverReply {
  classification: ApprovalClassification;
  by: string;            // approver name
  permalink: string;
  ts: string;            // Slack ts (chronological order key)
}

export interface ApprovalOutcome {
  decision: "approve" | "disapprove";
  reason: string;
  by: string;
  evidencePermalink: string;
}

export function parseArgs(argv: string[]): ApprovalsArgs {
  const args: ApprovalsArgs = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--write") { args.write = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: ApprovalsArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/**
 * Decide a day's outcome from its approver replies (pure). The MOST RECENT
 * decisive reply (approve/disapprove) wins — approvers can change their mind;
 * `unclear` replies are ignored. Returns null when no approver gave a decision.
 */
export function decideApproval(replies: ApproverReply[]): ApprovalOutcome | null {
  const decisive = replies
    .filter((r) => r.classification.decision !== "unclear")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (decisive.length === 0) return null;
  const latest = decisive[decisive.length - 1];
  return {
    decision: latest.classification.decision as "approve" | "disapprove",
    reason: latest.classification.reason,
    by: latest.by,
    evidencePermalink: latest.permalink,
  };
}
