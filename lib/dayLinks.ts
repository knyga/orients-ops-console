// lib/dayLinks.ts
/**
 * Pure planner for the #field-qa cross-links (🔗) — spec
 * docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md.
 *
 * A flight day's message CLUSTER is derived from stores every post already
 * wrote (no registry of its own, so nothing can drift): the drone reminder and
 * the bot's Звіт-thread reply from `outbound_messages`, the verdict from
 * `published`, the bonus breakdown from `bonus_notified` (+ its text from
 * `outbound_messages`), the monthly summary chunk from `outbound_messages`.
 * `renderLinks` builds the one trailing 🔗 line each target should carry;
 * `planRelink` emits an edit only where the message's current line differs
 * (content-hash keyed, so an unchanged cluster dedups at the chokepoint).
 * No DB / Slack / Next imports; unit-tested.
 */
import { LINKS_MARKER, splitLinksRegion, withLinksRegion } from "./linksRegion";
import { contentRev, linksEditKey, linksZvitEditKey, linksZvitKey, type LinksTarget } from "./outboundKeys";
import { droneReminderKey } from "./droneReminderPlan";
import { reportKey } from "./fieldDayVerdict";
import type { PublishedLog } from "./published";
import type { NotifiedLog } from "./bonusNotified";

export interface OutboundRowLike {
  key: string;
  feature: string;
  status: string;
  ts: string | null;
  text: string;
  channel: string;
  /** When the row was actually sent (null for a pending/failed row). Used to
   *  pick the CURRENT text among several rows that share a target ts — see
   *  `latestTextForTs`. */
  sentAt: string | null;
}

export interface ReportNodes {
  reportTs: string;
  verdictTs?: string;
  /**
   * The verdict message's CURRENT Slack text — the newest sent outbound row
   * sharing its ts (an approval/roster/links/backfill edit, or the original
   * post when none exists), never the possibly-stale `published.text`. See
   * `lib/liveText.ts liveVerdictText` (same rule, entry-shaped) — an
   * approver-overridden verdict's live text already carries the strike, so
   * the edit here never clobbers it.
   */
  verdictText?: string;
  bonusTs?: string;
  bonusText?: string;
  zvitReplyTs?: string;
  zvitReplyText?: string;
}

export interface DayNodes {
  date: string;
  reminderTs?: string;
  reminderText?: string;
  /** Ordered by Звіт ts ascending — the ordinal «N/M» order. */
  reports: ReportNodes[];
  /** The summary thread chunk that carries this day's line (unambiguous match only). */
  summaryTs?: string;
}

export interface CollectInput {
  date: string;
  /** Tracked channel NAME the cluster lives in (all nodes must match it). */
  channel: string;
  published: PublishedLog;
  notified: NotifiedLog;
  outbound: OutboundRowLike[];
}

const SUMMARY_FEATURE = "field-summary";

function sentRow(rows: OutboundRowLike[], pred: (r: OutboundRowLike) => boolean): OutboundRowLike | undefined {
  return rows.find((r) => r.status === "sent" && r.ts && pred(r));
}

/**
 * The CURRENT text of a target message: among SENT rows sharing `ts` (an
 * original post plus zero or more later edit rows recorded under their own
 * key — see the design doc's "Link line" section), the text of the one with
 * the greatest `sentAt` (a null `sentAt` sorts as oldest). Non-sent rows and
 * rows for a different ts are ignored. Fixes the bug where the planner read
 * a target's ORIGINAL post row for its text, re-planned an edit that had
 * already landed under a different key, and the chokepoint's dedup return
 * value (a non-empty ts) was miscounted as a fresh send.
 */
export function latestTextForTs(rows: OutboundRowLike[], ts: string): string | undefined {
  let best: OutboundRowLike | undefined;
  for (const r of rows) {
    if (r.status !== "sent" || r.ts !== ts) continue;
    if (!best || (r.sentAt ?? "") > (best.sentAt ?? "")) best = r;
  }
  return best?.text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The one summary thread chunk whose text has a line starting with «*DD.MM » for `date`; null when none or ambiguous. */
export function summaryChunkFor(date: string, rows: OutboundRowLike[], channel: string): string | null {
  const label = `*${date.slice(8, 10)}.${date.slice(5, 7)} `;
  const re = new RegExp(`(^|\\n)${escapeRegExp(label)}`);
  const hits = new Set(
    rows
      .filter((r) => r.feature === SUMMARY_FEATURE && r.status === "sent" && r.ts && r.channel === channel && !r.key.endsWith(":anchor") && re.test(r.text))
      .map((r) => r.ts as string),
  );
  return hits.size === 1 ? [...hits][0] : null;
}

export function collectDayNodes(input: CollectInput): DayNodes {
  const { date, channel, published, notified, outbound } = input;
  // Text lookups must stay within this cluster's channel — a foreign-channel
  // row can share a ts by coincidence in tests, and must never leak in.
  const channelRows = outbound.filter((r) => r.channel === channel);
  const reminder = sentRow(outbound, (r) => r.key === droneReminderKey(date) && r.channel === channel);
  const reports: ReportNodes[] = Object.values(published)
    .filter((e) => e.date === date && e.channel === channel && e.reportTs)
    .sort((a, b) => Number(a.reportTs) - Number(b.reportTs))
    .map((e) => {
      const reportTs = e.reportTs as string;
      const key = reportKey(date, reportTs);
      const node: ReportNodes = { reportTs, verdictTs: e.ts, verdictText: latestTextForTs(channelRows, e.ts) ?? e.text };
      const bonusTs = notified[key]?.threadTs;
      if (bonusTs) {
        node.bonusTs = bonusTs;
        const bonusText = latestTextForTs(channelRows, bonusTs);
        if (bonusText !== undefined) node.bonusText = bonusText;
      }
      const zvit = sentRow(outbound, (r) => r.key === linksZvitKey(reportTs) && r.channel === channel);
      if (zvit) {
        node.zvitReplyTs = zvit.ts as string;
        node.zvitReplyText = latestTextForTs(channelRows, zvit.ts as string) ?? zvit.text;
      }
      return node;
    });
  const summaryTs = summaryChunkFor(date, outbound, channel);
  return {
    date,
    ...(reminder ? { reminderTs: reminder.ts as string, reminderText: latestTextForTs(channelRows, reminder.ts as string) ?? reminder.text } : {}),
    reports,
    ...(summaryTs ? { summaryTs } : {}),
  };
}

type Link = { label: string; ts: string };

function ordinal(i: number, n: number): string {
  return n > 1 ? ` ${i + 1}/${n}` : "";
}

/** The 🔗 line `target` should carry given the day's nodes, or null when there is nothing to link. */
export function renderLinks(target: LinksTarget, nodes: DayNodes, permalink: (ts: string) => string): string | null {
  const links: Link[] = [];
  const n = nodes.reports.length;
  if (target.kind === "reminder") {
    nodes.reports.forEach((r, i) => links.push({ label: `Звіт${ordinal(i, n)}`, ts: r.reportTs }));
    nodes.reports.forEach((r, i) => { if (r.verdictTs) links.push({ label: `Вердикт${ordinal(i, n)}`, ts: r.verdictTs }); });
    nodes.reports.forEach((r, i) => { if (r.bonusTs) links.push({ label: `Бонуси${ordinal(i, n)}`, ts: r.bonusTs }); });
  } else {
    const r = nodes.reports.find((x) => x.reportTs === target.reportTs);
    if (!r) return null;
    if (target.kind !== "zvit") links.push({ label: "Звіт", ts: r.reportTs });
    if (target.kind === "zvit" && r.verdictTs) links.push({ label: "Вердикт", ts: r.verdictTs });
    if (nodes.reminderTs) links.push({ label: "Дрони", ts: nodes.reminderTs });
    if (target.kind !== "bonus" && r.bonusTs) links.push({ label: "Бонуси", ts: r.bonusTs });
  }
  if (nodes.summaryTs) links.push({ label: "Підсумок", ts: nodes.summaryTs });
  if (links.length === 0) return null;
  return `${LINKS_MARKER}${links.map((l) => `<${permalink(l.ts)}|${l.label}>`).join(" · ")}`;
}

export interface RelinkEdit {
  target: LinksTarget;
  op: "edit" | "post";
  /** Message to edit (null for a post). */
  ts: string | null;
  /** Thread root for a post (null for an edit). */
  threadTs: string | null;
  newText: string;
  key: string;
}

/**
 * The edits/posts that bring every target's 🔗 line up to date. A target whose
 * current text is unknown or empty is skipped — never edit blind. A verdict
 * IS edited even when its report carries an approver override: `verdictText`
 * (from `collectDayNodes`) is already the message's CURRENT live text — the
 * newest sent outbound row sharing its ts, which for an overridden verdict is
 * the approval edit (struck body + amendment), never the stale pristine
 * `published.text` — so appending/replacing the 🔗 line here can't clobber the
 * live strike. The Звіт-thread reply is POSTED only when `zvitReply` is on and
 * the report already has a verdict; an existing reply is always kept current.
 */
export function planRelink(nodes: DayNodes, opts: { permalink: (ts: string) => string; zvitReply: boolean }): RelinkEdit[] {
  const out: RelinkEdit[] = [];
  const edit = (target: LinksTarget, ts: string, current: string) => {
    const line = renderLinks(target, nodes, opts.permalink);
    const next = withLinksRegion(current, line);
    if (next === current || line === null) return;
    out.push({ target, op: "edit", ts, threadTs: null, newText: next, key: linksEditKey(target, contentRev(line)) });
  };
  if (nodes.reminderTs && nodes.reminderText) edit({ kind: "reminder", date: nodes.date }, nodes.reminderTs, nodes.reminderText);
  for (const r of nodes.reports) {
    if (r.verdictTs && r.verdictText) edit({ kind: "verdict", date: nodes.date, reportTs: r.reportTs }, r.verdictTs, r.verdictText);
    if (r.bonusTs && r.bonusText) edit({ kind: "bonus", date: nodes.date, reportTs: r.reportTs }, r.bonusTs, r.bonusText);
    const target: LinksTarget = { kind: "zvit", reportTs: r.reportTs };
    const line = renderLinks(target, nodes, opts.permalink);
    if (r.zvitReplyTs && r.zvitReplyText !== undefined) {
      if (line !== null && splitLinksRegion(r.zvitReplyText).linksLine !== line) {
        out.push({ target, op: "edit", ts: r.zvitReplyTs, threadTs: null, newText: line, key: linksZvitEditKey(r.reportTs, contentRev(line)) });
      }
    } else if (opts.zvitReply && r.verdictTs && line !== null) {
      out.push({ target, op: "post", ts: null, threadTs: r.reportTs, newText: line, key: linksZvitKey(r.reportTs) });
    }
  }
  return out;
}
