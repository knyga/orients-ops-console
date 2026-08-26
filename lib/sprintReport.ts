/**
 * Pure sprint-completion logic. No React/Next/node imports — unit-tested, same
 * discipline as lib/reconcile.ts and lib/jiraStats.ts.
 *
 * Domain (see docs/superpowers/specs/2026-07-19-sprint-completion-design.md):
 *  - Weekly sprint on the Autopilot board. The COMMITTED baseline is the exact
 *    set of issues in the active sprint at the Monday-~21:00-Kyiv snapshot; it is
 *    frozen to an artifact and never recomputed.
 *  - COMPLETION is issue-count based: a frozen issue is done when its status is in
 *    the `Done` status CATEGORY (any terminal/green status), not the literal name.
 *  - STUCK across sprints: a frozen issue that is NOT done and has lived in >= 2
 *    sprints (carried over from >= 1 prior sprint). A first-attempt issue (sprint
 *    count 1) is never flagged.
 *
 * lib/jira.ts maps Jira's REST response into SprintIssue; everything here depends
 * only on that shape.
 */

import { mention } from "./mention";
import { personForJiraAccountId } from "./people";
import { byteLength, chunkForSlack, SLACK_MSG_MAX_BYTES } from "./slackChunk";

export interface SprintIssue {
  key: string;
  summary: string;
  assignee: { accountId: string; displayName: string } | null;
  /** Human status name, e.g. "In Progress". */
  statusName: string;
  /** Status CATEGORY name, e.g. "Done" | "In Progress" | "To Do". */
  statusCategory: string;
  /** Distinct sprints this issue has ever belonged to (>= 1). */
  sprintCount: number;
}

export interface SprintSnapshot {
  sprintId: number;
  sprintName: string;
  slug: string;
  /** ISO timestamp the baseline was frozen. */
  capturedAt: string;
  issues: SprintIssue[];
}

export interface AssigneeGroup {
  accountId: string | null;
  displayName: string;
  issues: SprintIssue[];
}

export interface IssueRef {
  key: string;
  summary: string;
}

export interface AssigneeCompletion {
  accountId: string | null;
  displayName: string;
  /** Frozen issues attributed to this person. */
  committed: number;
  /** Done-category count. */
  done: number;
  /** Whole-percent per-person rate (0 when committed === 0). */
  rate: number;
  /** Done-category issues grouped by live status name; "Done" first, rest alphabetical. */
  doneByStatus: { status: string; issues: IssueRef[] }[];
  /** Non-done issues whose status changed since the freeze; alphabetical by "from -> to". */
  transitions: { from: string; to: string; issues: IssueRef[] }[];
  /** Non-done issues with an unchanged status; `status` is the current status name. */
  noProgress: { status: string; key: string; summary: string }[];
}

export interface StuckIssue {
  key: string;
  summary: string;
  displayName: string;
  /** Live status name (frozen fallback when absent from live). */
  statusName: string;
  sprintCount: number;
}

export interface CompletionResult {
  committed: number;
  completed: number;
  /** Whole-percent completion rate (0 when nothing committed). */
  rate: number;
  /** Every committed assignee (not only those with done issues); unassigned last. */
  assignees: AssigneeCompletion[];
  /** Incomplete issues carried across >= 2 sprints. */
  stuck: StuckIssue[];
}

const UNASSIGNED_LABEL = "Не призначено";

/** Sprint name → filesystem/URL-safe slug: "ATP 42" → "ATP-42". */
export function slugifySprint(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when a status CATEGORY is the terminal "Done" (green) category. */
export function isDone(statusCategory: string): boolean {
  return statusCategory.trim().toLowerCase() === "done";
}

/** Ukrainian plural for a sprint count: "2 спринти", "5 спринтів". */
export function pluralizeSprints(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word: string;
  if (mod10 === 1 && mod100 !== 11) word = "спринт";
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = "спринти";
  else word = "спринтів";
  return `${n} ${word}`;
}

/** Stable assignee display name (unassigned → the Ukrainian label). */
function assigneeName(issue: SprintIssue): string {
  return issue.assignee?.displayName ?? UNASSIGNED_LABEL;
}

/** Slack label for an assignee: "Display Name (<@SLACKID>)" when the Jira
 *  accountId maps to a person with a slackId, else the plain display name. */
function assigneeLabel(group: { accountId: string | null; displayName: string }): string {
  const p = group.accountId ? personForJiraAccountId(group.accountId) : undefined;
  return p?.slackId ? `${group.displayName} (${mention(p)})` : group.displayName;
}

/**
 * Group issues by assignee. Assignees are sorted by name; the unassigned bucket
 * is always ordered last. Deterministic for stable message/render output.
 */
export function groupByAssignee(issues: SprintIssue[]): AssigneeGroup[] {
  const groups = new Map<string, AssigneeGroup>();
  for (const issue of issues) {
    const id = issue.assignee?.accountId ?? "__unassigned__";
    let g = groups.get(id);
    if (!g) {
      g = { accountId: issue.assignee?.accountId ?? null, displayName: assigneeName(issue), issues: [] };
      groups.set(id, g);
    }
    g.issues.push(issue);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.accountId === null) return 1;
    if (b.accountId === null) return -1;
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Measure completion of a frozen baseline against a live re-fetch, classifying
 * every frozen issue per assignee: done (grouped by live status name — CANCELLED
 * etc. still count toward the rate), transitioned (frozen status ≠ live status),
 * or no progress. A frozen key absent from `live` keeps its frozen fields, so it
 * counts as not done with no transition.
 */
export function computeCompletion(frozen: SprintIssue[], live: SprintIssue[]): CompletionResult {
  const liveByKey = new Map(live.map((i) => [i.key, i]));
  const committed = frozen.length;

  interface Acc {
    accountId: string | null;
    displayName: string;
    committed: number;
    done: number;
    doneByStatus: Map<string, IssueRef[]>;
    transitions: Map<string, { from: string; to: string; issues: IssueRef[] }>;
    noProgress: { status: string; key: string; summary: string }[];
  }
  const accs = new Map<string, Acc>();
  const stuck: StuckIssue[] = [];
  let completed = 0;

  for (const f of frozen) {
    // Prefer the live status/assignee/summary; fall back to the frozen snapshot.
    const merged = liveByKey.get(f.key) ?? f;
    const id = merged.assignee?.accountId ?? "__unassigned__";
    let a = accs.get(id);
    if (!a) {
      a = {
        accountId: merged.assignee?.accountId ?? null,
        displayName: assigneeName(merged),
        committed: 0,
        done: 0,
        doneByStatus: new Map(),
        transitions: new Map(),
        noProgress: [],
      };
      accs.set(id, a);
    }
    a.committed++;

    const ref: IssueRef = { key: f.key, summary: merged.summary };
    if (isDone(merged.statusCategory)) {
      completed++;
      a.done++;
      const arr = a.doneByStatus.get(merged.statusName) ?? [];
      arr.push(ref);
      a.doneByStatus.set(merged.statusName, arr);
    } else {
      if (merged.statusName !== f.statusName) {
        const key = `${f.statusName} -> ${merged.statusName}`;
        const bucket = a.transitions.get(key) ?? { from: f.statusName, to: merged.statusName, issues: [] };
        bucket.issues.push(ref);
        a.transitions.set(key, bucket);
      } else {
        a.noProgress.push({ status: merged.statusName, key: f.key, summary: merged.summary });
      }
      if (merged.sprintCount >= 2) {
        stuck.push({
          key: f.key,
          summary: merged.summary,
          displayName: assigneeName(merged),
          statusName: merged.statusName,
          sprintCount: merged.sprintCount,
        });
      }
    }
  }

  const assignees: AssigneeCompletion[] = [...accs.values()]
    .map((a) => ({
      accountId: a.accountId,
      displayName: a.displayName,
      committed: a.committed,
      done: a.done,
      rate: a.committed === 0 ? 0 : Math.round((a.done / a.committed) * 100),
      doneByStatus: [...a.doneByStatus.entries()]
        .sort(([s1], [s2]) => (s1 === "Done" ? -1 : s2 === "Done" ? 1 : s1.localeCompare(s2)))
        .map(([status, issues]) => ({ status, issues })),
      transitions: [...a.transitions.values()].sort((x, y) =>
        `${x.from} -> ${x.to}`.localeCompare(`${y.from} -> ${y.to}`),
      ),
      noProgress: a.noProgress,
    }))
    .sort((x, y) => {
      if (x.accountId === null) return 1;
      if (y.accountId === null) return -1;
      return x.displayName.localeCompare(y.displayName);
    });

  const rate = committed === 0 ? 0 : Math.round((completed / committed) * 100);
  return { committed, completed, rate, assignees, stuck };
}

/** One logical section of the thread detail: a header plus its item lines. */
interface DetailBlock {
  header: string;
  /** Header to repeat when the block spills into a following message. */
  contHeader: string;
  lines: string[];
}

const renderBlock = (header: string, lines: string[]): string => [header, ...lines].join("\n");

/**
 * Split one block that cannot fit a single message into header-repeating parts,
 * at LINE boundaries, so a spilled section never reads as an orphan tail. A single
 * line longer than the cap is hard-split by chunkForSlack (pathological only).
 */
function splitBlock(block: DetailBlock, maxBytes: number): string[] {
  const out: string[] = [];
  let header = block.header;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    out.push(renderBlock(header, lines));
    header = block.contHeader;
    lines = [];
  };
  for (const line of block.lines) {
    if (lines.length > 0 && byteLength(renderBlock(header, [...lines, line])) > maxBytes) flush();
    if (byteLength(renderBlock(header, [line])) > maxBytes) {
      // One item longer than a whole message (pathological — Jira summaries are
      // capped at 255 chars). Hard-split the LINE and give every piece a header,
      // so no message is a header alone or a headerless fragment.
      flush();
      const room = Math.max(1, maxBytes - byteLength(`${block.contHeader}\n`));
      for (const piece of chunkForSlack(line, room)) {
        out.push(renderBlock(header, [piece]));
        header = block.contHeader;
      }
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

/**
 * Pack the detail blocks (one per assignee, plus the stuck list) into as few Slack
 * messages as fit under the per-message byte cap. Slack's chat.postMessage
 * SILENTLY splits a text over ~4000 chars into consecutive messages (observed
 * 2026-08-23 on the ATP-47 completed report: one send, two channel messages, and
 * the recorded ts pointed at the tail) — so we own the split instead: a short
 * anchor post plus these detail messages as its thread replies.
 */
function packBlocks(blocks: DetailBlock[], maxBytes: number = SLACK_MSG_MAX_BYTES): string[] {
  const out: string[] = [];
  let current = "";
  for (const block of blocks) {
    const rendered = renderBlock(block.header, block.lines);
    const candidate = current ? `${current}\n\n${rendered}` : rendered;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current) {
      out.push(current);
      current = "";
    }
    if (byteLength(rendered) > maxBytes) {
      const pieces = splitBlock(block, maxBytes);
      out.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
    } else {
      current = rendered;
    }
  }
  if (current) out.push(current);
  return out;
}

const THREAD_HINT_COMMITTED = "🧵 Повний список — у треді.";
const THREAD_HINT_COMPLETED = "🧵 Деталі — у треді.";
const ROSTER_HEADER_COMMITTED = "👥 Розподіл задач:";
const ROSTER_HEADER_COMPLETED = "👥 Прогрес по людях:";

/** One sprint Slack post: a short channel ANCHOR plus its thread replies. */
export interface SprintPost {
  /** The single channel message. Always within SLACK_MSG_MAX_BYTES. */
  anchor: string;
  /** Detail messages to post as replies in the anchor's thread (may be empty). */
  details: string[];
}

/**
 * Assemble the anchor + thread messages, keeping the ANCHOR within one Slack
 * message. The per-assignee roster is the only unbounded part of an anchor, so an
 * anchor that would exceed the cap sheds the roster into the FIRST thread block
 * instead — never letting Slack do the splitting for us (that is the whole bug
 * this shape exists to fix; an anchor Slack splits itself leaves the recorded ts
 * on the tail message and threads every reply under it).
 */
function assemblePost(
  headLines: string[],
  roster: string[],
  tailLines: string[],
  hint: string,
  rosterHeader: string,
  blocks: DetailBlock[],
  maxBytes: number = SLACK_MSG_MAX_BYTES,
): SprintPost {
  const anchorLines = (withRoster: boolean, hasThread: boolean): string[] => {
    const lines = [...headLines];
    if (withRoster && roster.length > 0) lines.push("", ...roster);
    lines.push(...tailLines);
    // Only promise a thread when there actually is one.
    if (hasThread) lines.push("", hint);
    return lines;
  };

  let allBlocks = blocks;
  let anchor = anchorLines(true, blocks.length > 0).join("\n");
  if (byteLength(anchor) > maxBytes) {
    allBlocks = [
      { header: rosterHeader, contHeader: `${rosterHeader} _(продовження)_`, lines: roster },
      ...blocks,
    ];
    anchor = anchorLines(false, true).join("\n");
  }
  return { anchor, details: packBlocks(allBlocks, maxBytes) };
}

/**
 * The Tuesday "Committed" post: an anchor with the headline count + one line per
 * assignee, and the per-issue list (grouped by assignee → status, Jira keys and
 * summaries verbatim) as thread replies.
 */
export function buildCommittedPost(
  snapshot: SprintSnapshot,
  maxBytes: number = SLACK_MSG_MAX_BYTES,
): SprintPost {
  const groups = groupByAssignee(snapshot.issues);
  const blocks: DetailBlock[] = [];
  for (const group of groups) {
    const header = `*${assigneeLabel(group)}*`;
    const lines: string[] = [];
    // Within an assignee, order by status name for a stable, readable grouping.
    const byStatus = new Map<string, SprintIssue[]>();
    for (const issue of group.issues) {
      const arr = byStatus.get(issue.statusName) ?? [];
      arr.push(issue);
      byStatus.set(issue.statusName, arr);
    }
    for (const status of [...byStatus.keys()].sort((a, b) => a.localeCompare(b))) {
      lines.push(`  ${status}:`);
      for (const issue of byStatus.get(status)!) {
        lines.push(`    • ${issue.key} — ${issue.summary}`);
      }
    }
    blocks.push({ header, contHeader: `${header} _(продовження)_`, lines });
  }

  return assemblePost(
    [`📋 Спринт *${snapshot.sprintName}* — взято в роботу: ${snapshot.issues.length} задач`],
    groups.map((g) => `• ${assigneeLabel(g)} — ${g.issues.length}`),
    [],
    THREAD_HINT_COMMITTED,
    ROSTER_HEADER_COMMITTED,
    blocks,
    maxBytes,
  );
}

/**
 * The Monday "Completed" post: an anchor with the overall rate, one line per
 * committed assignee, and the stuck COUNT; the thread carries every assignee's
 * buckets (done by status name, transitions since the freeze, no progress) and
 * the full stuck list. Bucket headers are English Jira status names verbatim;
 * the rest Ukrainian.
 */
export function buildCompletedPost(
  sprintName: string,
  result: CompletionResult,
  maxBytes: number = SLACK_MSG_MAX_BYTES,
): SprintPost {
  const blocks: DetailBlock[] = [];
  for (const a of result.assignees) {
    const header = `*${assigneeLabel(a)}* — ${a.done}/${a.committed} (${a.rate}%)`;
    const lines: string[] = [];
    for (const bucket of a.doneByStatus) {
      lines.push(`  ${bucket.status}:`);
      for (const i of bucket.issues) lines.push(`    • ${i.key} — ${i.summary}`);
    }
    for (const t of a.transitions) {
      lines.push(`  ${t.from} -> ${t.to}:`);
      for (const i of t.issues) lines.push(`    • ${i.key} — ${i.summary}`);
    }
    if (a.noProgress.length > 0) {
      lines.push("  No progress:");
      for (const i of a.noProgress) lines.push(`    • ${i.status} - ${i.key} — ${i.summary}`);
    }
    blocks.push({ header, contHeader: `${header} _(продовження)_`, lines });
  }

  if (result.stuck.length > 0) {
    blocks.push({
      header: "⚠️ Зависли (кілька спринтів):",
      contHeader: "⚠️ Зависли (кілька спринтів) _(продовження)_:",
      lines: result.stuck.map(
        (s) =>
          `  • ${s.statusName} - ${s.displayName} - ${s.key} — ${s.summary} (${pluralizeSprints(s.sprintCount)})`,
      ),
    });
  }

  const head = [
    `✅ Спринт *${sprintName}* — виконано ${result.completed}/${result.committed} (${result.rate}%)`,
  ];
  if (result.completed === 0) head.push("", "_Жодної задачі не завершено._");

  return assemblePost(
    head,
    result.assignees.map((a) => `• ${assigneeLabel(a)} — ${a.done}/${a.committed} (${a.rate}%)`),
    result.stuck.length > 0 ? ["", `⚠️ Зависли (кілька спринтів): ${result.stuck.length}`] : [],
    THREAD_HINT_COMPLETED,
    ROSTER_HEADER_COMPLETED,
    blocks,
    maxBytes,
  );
}

/**
 * The FALLBACK anchor the Tuesday commit job posts when the board has no active
 * sprint (rollover is a human action whose time varies — see
 * docs/superpowers/specs/2026-08-26-sprint-plan-fallback-design.md). The miss is
 * made visible in the same place the plan would have been, and the text tells an
 * approver how to trigger the mention-driven fill-in that rewrites THIS message
 * into the real Committed post. Pure like its buildCommittedPost sibling: no
 * Jira, no Slack, no clock — the caller supplies the Kyiv day.
 */
export function formatNoSprintAnchor(dayKyiv: string): string {
  return [
    `📋 План спринту не складено — на дошці немає активного спринту (${dayKyiv}).`,
    "Створіть спринт у Jira і згадайте мене (@bot) у цьому треді — складу план і оновлю це повідомлення.",
  ].join("\n");
}
