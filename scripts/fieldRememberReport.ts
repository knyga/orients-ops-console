/**
 * Pure CLI shaping for the remember command (S6): arg parsing, period resolution,
 * and the outcome decision that turns a thread's classified replies into an ask
 * state transition + (optionally) a pilot-origin escalation for approvers. No
 * server/Next/fs imports — unit-tested.
 */
import type { AskState } from "../lib/asks";
import type { AnswerClassification } from "../lib/answerClassifyPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  start: string;
  end: string;
}

export interface RememberArgs {
  start?: string;
  end?: string;
  /** Apply the outcomes (write resolutions + advance ask states). Default false = dry-run. */
  write: boolean;
}

/** A classified reply with its source permalink (for evidence). */
export interface ClassifiedReply {
  classification: AnswerClassification;
  permalink: string;
}

export interface Outcome {
  /** New ask state to set. */
  state: AskState;
  /** Create a pilot-origin proposal for approvers (never write a resolution directly). */
  escalate: boolean;
  /** Summary note carried to the ask record. */
  note: string;
  /** Evidence permalink (the deciding reply), when any. */
  evidencePermalink: string;
  /** The claim text to escalate, when `escalate` is true. */
  claimText?: string;
}

export function parseArgs(argv: string[]): RememberArgs {
  const args: RememberArgs = { write: false };
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

export function resolvePeriod(args: RememberArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/**
 * Decide a thread's outcome from its classified replies (pure):
 *  - any accepted_exception → ESCALATED (a pilot-origin proposal for approvers;
 *    never a direct resolution write).
 *  - else any data_provided → ANSWERED (the gap may be filled; the next verdict
 *    recompute verifies it live — no exception needed).
 *  - else any reply at all  → ANSWERED (human responded but gap unresolved).
 *  - no replies             → null (leave the ask untouched).
 * The first matching reply (in order) is the deciding evidence.
 */
export function decideOutcome(replies: ClassifiedReply[]): Outcome | null {
  if (replies.length === 0) return null;

  const exception = replies.find((r) => r.classification.type === "accepted_exception");
  if (exception) {
    return {
      state: "ESCALATED",
      escalate: true,
      note: exception.classification.note,
      evidencePermalink: exception.permalink,
      claimText: exception.classification.note,
    };
  }
  const provided = replies.find((r) => r.classification.type === "data_provided");
  if (provided) {
    return {
      state: "ANSWERED",
      escalate: false,
      note: `дані надано — перевірка при наступному розрахунку: ${provided.classification.note}`,
      evidencePermalink: provided.permalink,
    };
  }
  const last = replies[replies.length - 1];
  return { state: "ANSWERED", escalate: false, note: last.classification.note, evidencePermalink: last.permalink };
}
