/**
 * Shared sprint-completion orchestration, used by BOTH the `npm run sprint` CLI
 * and the two Vercel cron routes (mirrors lib/runNightly.ts). Server-side: pulls
 * the active sprint from Jira, freezes/loads the committed baseline, computes
 * completion, and (when publishing) posts to #general via the lib/slack.ts
 * reserve-then-send chokepoint.
 *
 * SHAPE: one short ANCHOR post (headline + per-assignee counts) plus the per-issue
 * detail as THREAD REPLIES under it. Slack's chat.postMessage silently splits any
 * text over ~4000 chars into consecutive channel messages (observed 2026-08-23:
 * the ATP-47 completed report landed as two #general posts from a single send, and
 * the recorded ts pointed at the tail), so the split is ours to own.
 *
 * DRY-RUN aware: with `publish:false` it computes everything and returns the exact
 * anchor + thread texts without posting.
 */
import { boardIdFromEnv, fetchIssuesByKeys, fetchSprintIssues, listSprints, type Sprint } from "./jira";
import { postMessage, updateMessage } from "./slack";
import { claimSentKey } from "./outbound";
import { TRACKED_CHANNELS } from "./slackChannels";
import {
  sprintAnchorKey,
  sprintPlanFilledKey,
  sprintPlanPendingKey,
  sprintThreadKey,
  type SendTrigger,
} from "./outboundKeys";
import { readSprint, writeSprint, type SprintRecord } from "./sprintStore";
import {
  buildCommittedPost,
  buildCompletedPost,
  computeCompletion,
  formatNoSprintAnchor,
  slugifySprint,
  type SprintPost,
  type SprintSnapshot,
} from "./sprintReport";
import { resolvePlan, upsertPlan, type SprintPostKind } from "./sprintPublish";

export interface RunSprintOptions {
  publish: boolean;
  /** Tracked channel NAME to post to (default "general"). */
  channelName?: string;
  /** Override the auto-picked active sprint by id (matched among active+future). */
  sprintId?: number;
  trigger?: SendTrigger;
}

export type CommitResult =
  | {
      status: "no-active-sprint";
      /** The Ukrainian fallback anchor (posted when publishing; the CLI dry-run
       *  prints the exact text it would have sent). */
      anchor: string;
      posted: boolean;
    }
  | {
      status: "ok";
      slug: string;
      sprintName: string;
      count: number;
      /** The short #general post. */
      anchor: string;
      /** Detail messages posted as replies in the anchor's thread. */
      details: string[];
      posted: boolean;
    };

export type ReportResult =
  | { status: "no-active-sprint" }
  | { status: "no-baseline"; slug: string; sprintName: string }
  | {
      status: "ok";
      slug: string;
      sprintName: string;
      committed: number;
      completed: number;
      rate: number;
      stuck: number;
      /** The short #general post. */
      anchor: string;
      /** Detail messages posted as replies in the anchor's thread. */
      details: string[];
      posted: boolean;
    };

/** Resolve the sprint to act on: an explicit id (among active+future), else the
 *  single active sprint. Null when the board has no active sprint and no override. */
async function resolveSprint(boardId: number, sprintId?: number): Promise<Sprint | null> {
  if (sprintId !== undefined) {
    const [active, future] = await Promise.all([
      listSprints(boardId, "active"),
      listSprints(boardId, "future"),
    ]);
    return [...active, ...future].find((s) => s.id === sprintId) ?? null;
  }
  const active = await listSprints(boardId, "active");
  return active[0] ?? null;
}

/** Resolve a tracked channel name → id, or throw a clear error. */
function channelIdByName(name: string): string {
  const found = TRACKED_CHANNELS.find((c) => c.name === name);
  if (!found) {
    throw new Error(
      `Unknown channel "${name}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).`,
    );
  }
  return found.id;
}

/**
 * Publish one sprint post: freeze the exact texts in the sprint record, post the
 * anchor, then each detail message as a reply in ITS thread. Every send goes
 * through the deduping chokepoint, so a cron re-fire — or a retry after a run that
 * died mid-thread — re-sends only what never landed, and replays the frozen texts
 * so the positional reply keys still describe the same content.
 *
 * A send whose key is held by a stuck `pending` row comes back with an EMPTY ts
 * (lib/sendTracked.ts returns the existing ts, which is null there). That must be
 * loud: silently continuing would drop that chunk's issues while still reporting a
 * successful publish. `decideReserve` only reclaims `failed` rows, so a hard-killed
 * run (Vercel timeout/OOM, which never reaches `markFailed`) needs the pending row
 * cleared before the retry can go through.
 */
async function publishPost(
  slug: string,
  kind: SprintPostKind,
  channelName: string,
  fresh: SprintPost,
  record: SprintRecord,
  trigger: SendTrigger,
  opts?: {
    /** REWRITE mode (the sprint-plan fill-in): the anchor already exists — the
     *  pending fallback post at this ts. The anchor is EDITED in place instead
     *  of posted, and the anchor key is CLAIMED against it. Details thread
     *  identically in both modes. */
    rewriteTs?: string;
  },
): Promise<{ anchorTs: string; post: SprintPost }> {
  const channelId = channelIdByName(channelName);
  const { plan, replayed } = resolvePlan(
    record.published,
    kind,
    channelName,
    fresh,
    new Date().toISOString(),
  );
  if (!replayed) {
    await writeSprint(slug, { ...record, published: upsertPlan(record.published, plan) });
  }

  const meta = { feature: "sprint" as const, channel: channelName, trigger };
  const anchorKey = sprintAnchorKey(kind, slug, channelName);
  let anchorTs: string;
  if (opts?.rewriteTs) {
    // Fill-in: edit the existing fallback anchor into the real post. The edit
    // key is namespaced apart from the anchor key (sprintPlanFilledKey), so no
    // reservation can skip it and a same-slug retry dedups cleanly.
    anchorTs = opts.rewriteTs;
    const filledKey = sprintPlanFilledKey(slug, channelName);
    const editTs = await updateMessage(channelId, anchorTs, plan.anchor, {
      ...meta,
      key: filledKey,
    });
    // An empty ts means the chokepoint SKIPPED the edit (a stuck pending row
    // holds the key): the anchor in Slack still shows the fallback text, so
    // claiming the anchor key or threading details now would fake a fill AND
    // suppress the cron that could recover it. Fail loudly, like the post
    // branch below.
    if (!editTs) {
      throw new Error(
        `sprint: the fill-in edit was skipped with no ts (key ${filledKey}) — a stuck pending row holds the key; clear it before retrying.`,
      );
    }
    // CLAIM the anchor key against the message that now carries the plan: the
    // fill-in posted no new anchor, so without this the next cron re-fire
    // (same sprint still active) would win the reservation and post a
    // DUPLICATE anchor whose details all dedup-skip into THIS thread.
    await claimSentKey(anchorKey, anchorTs, { ...meta, kind: "post", channelId, text: plan.anchor });
  } else {
    anchorTs = await postMessage(channelId, plan.anchor, { ...meta, key: anchorKey });
    if (!anchorTs) {
      throw new Error(
        `sprint: no ts for the anchor post (key ${anchorKey}) — a stuck pending row holds the key; clear it before retrying.`,
      );
    }
  }
  await threadDetails(channelId, anchorTs, plan.details, (i) => sprintThreadKey(kind, slug, channelName, i), trigger);
  return { anchorTs, post: { anchor: plan.anchor, details: plan.details } };
}

/**
 * Post each detail message as a reply in the anchor's thread, one deduped send
 * per positional key — shared by publishPost's post and rewrite modes (the
 * fill-in threads under the rewritten fallback anchor via the exact same keys).
 * The channel NAME for the audit meta is derived from the id (falls back to the
 * raw id for an untracked channel — audit metadata only, never routing).
 */
async function threadDetails(
  channelId: string,
  anchorTs: string,
  details: string[],
  threadKey: (index: number) => string,
  trigger: SendTrigger,
): Promise<void> {
  const channelName = TRACKED_CHANNELS.find((c) => c.id === channelId)?.name ?? channelId;
  const meta = { feature: "sprint" as const, channel: channelName, trigger };
  for (const [i, text] of details.entries()) {
    const key = threadKey(i + 1);
    const ts = await postMessage(channelId, text, { ...meta, key }, anchorTs);
    if (!ts) {
      throw new Error(
        `sprint: detail reply ${i + 1}/${details.length} was skipped with no ts (key ${key}) — a stuck pending row holds the key; clear it before retrying.`,
      );
    }
  }
}

/**
 * Fetch the sprint's live issue set and freeze it as the committed baseline.
 * A fresh snapshot for this sprint drops any stale completed result (re-earned
 * by the Monday report); a same-day re-fire re-freezes. Already-published plans
 * survive, so a retry replays them instead of repacking (lib/sprintPublish.ts).
 * Shared by the Tuesday commit job and the mention-driven fill-in.
 */
async function freezeCommitted(
  sprint: Sprint,
): Promise<{ snapshot: SprintSnapshot; record: SprintRecord }> {
  const issues = await fetchSprintIssues(sprint.id);
  const snapshot: SprintSnapshot = {
    sprintId: sprint.id,
    sprintName: sprint.name,
    slug: slugifySprint(sprint.name),
    capturedAt: new Date().toISOString(),
    issues,
  };
  const prior = await readSprint(snapshot.slug);
  const record: SprintRecord = { committed: snapshot, published: prior?.published };
  await writeSprint(snapshot.slug, record);
  return { snapshot, record };
}

/**
 * The mention-driven FILL-IN behind the agent's `sprint_plan_build` proposal
 * (docs/superpowers/specs/2026-08-26-sprint-plan-fallback-design.md): once the
 * sprint exists, freeze its baseline and publish the Committed post THROUGH
 * publishPost in rewrite mode — the pending fallback anchor at `anchorTs` is
 * edited in place, the anchor key is claimed against it (so a later cron
 * re-fire dedups instead of posting an orphan duplicate), and the details
 * thread under it with the frozen texts + positional keys a retry replays
 * byte-identically. The executor guards WHAT may be rewritten (findSentByTs);
 * this owns HOW the sprint is committed and published.
 */
export async function fillSprintPlan(args: {
  channelId: string;
  anchorTs: string;
  sprintId: number;
  trigger?: SendTrigger;
}): Promise<{ slug: string; sprintName: string; count: number }> {
  const sprint = await resolveSprint(boardIdFromEnv(), args.sprintId);
  if (!sprint) {
    throw new Error(
      "спринт зник між пропозицією та підтвердженням — перевірте його в Jira і спробуйте знову.",
    );
  }
  const channelName = TRACKED_CHANNELS.find((c) => c.id === args.channelId)?.name;
  if (!channelName) {
    throw new Error(`fillSprintPlan: channel id "${args.channelId}" is not a tracked channel.`);
  }
  const { snapshot, record } = await freezeCommitted(sprint);
  await publishPost(
    snapshot.slug,
    "committed",
    channelName,
    buildCommittedPost(snapshot),
    record,
    args.trigger ?? "unknown",
    { rewriteTs: args.anchorTs },
  );
  return { slug: snapshot.slug, sprintName: snapshot.sprintName, count: snapshot.issues.length };
}

/** Today's Kyiv calendar day (YYYY-MM-DD) — keys the fallback anchor's dedup. */
function kyivToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
}

/** Tuesday job: freeze the active sprint's issue set + post the Committed list. */
export async function runSprintCommit(opts: RunSprintOptions): Promise<CommitResult> {
  const boardId = boardIdFromEnv();
  const sprint = await resolveSprint(boardId, opts.sprintId);
  if (!sprint) {
    // An EXPLICIT --sprint id that matched nothing is an operator error, never
    // the rollover gap: posting «немає активного спринту» then (the board may
    // well have one) would be exactly the misleading post this fallback exists
    // to prevent. Fail loudly instead.
    if (opts.sprintId !== undefined) {
      throw new Error(
        `sprint: sprint id ${opts.sprintId} not found among active or future sprints on board ${boardId}.`,
      );
    }
    // FALLBACK: the cron fired inside the rollover gap (previous sprint closed,
    // next not started — observed 2026-08-10 and 2026-08-24, the ATP-46 miss
    // cascaded into a sprint with no record at all). Post a visible anchor to
    // the channel; an approver later @mentions the bot in its thread and the
    // agent's `sprint_plan_build` fill-in rewrites it into the real Committed
    // post. Keyed by Kyiv day: a re-fire dedups, next week posts anew.
    const day = kyivToday();
    const anchor = formatNoSprintAnchor(day);
    let posted = false;
    if (opts.publish) {
      const channelName = opts.channelName ?? "general";
      const key = sprintPlanPendingKey(day, channelName);
      const ts = await postMessage(channelIdByName(channelName), anchor, {
        feature: "sprint",
        channel: channelName,
        trigger: opts.trigger ?? "unknown",
        key,
      });
      // An empty ts means the chokepoint skipped the send (a stuck `pending`
      // row holds the key). Reporting `posted: true` then would recreate the
      // very invisible miss this fallback exists to surface — fail loud, like
      // publishPost does for its anchor.
      if (!ts) {
        throw new Error(
          `sprint: no ts for the fallback anchor (key ${key}) — a stuck pending row holds the key; clear it before retrying.`,
        );
      }
      posted = true;
    }
    return { status: "no-active-sprint", anchor, posted };
  }

  const { snapshot, record } = await freezeCommitted(sprint);

  let post = buildCommittedPost(snapshot);
  let posted = false;
  if (opts.publish) {
    ({ post } = await publishPost(
      snapshot.slug,
      "committed",
      opts.channelName ?? "general",
      post,
      record,
      opts.trigger ?? "unknown",
    ));
    posted = true;
  }
  const { anchor, details } = post;

  return {
    status: "ok",
    slug: snapshot.slug,
    sprintName: snapshot.sprintName,
    count: snapshot.issues.length,
    anchor,
    details,
    posted,
  };
}

/** Monday job: measure the frozen baseline's completion + post the Completed report. */
export async function runSprintReport(opts: RunSprintOptions): Promise<ReportResult> {
  const boardId = boardIdFromEnv();
  const sprint = await resolveSprint(boardId, opts.sprintId);
  if (!sprint) return { status: "no-active-sprint" };

  const slug = slugifySprint(sprint.name);
  const record = await readSprint(slug);
  if (!record) return { status: "no-baseline", slug, sprintName: sprint.name };

  const frozen = record.committed.issues;
  const live = await fetchIssuesByKeys(frozen.map((i) => i.key));
  const result = computeCompletion(frozen, live);

  const stored: SprintRecord = {
    committed: record.committed,
    completed: { computedAt: new Date().toISOString(), result },
    published: record.published,
  };
  await writeSprint(slug, stored);

  let post = buildCompletedPost(sprint.name, result);
  let posted = false;
  if (opts.publish) {
    ({ post } = await publishPost(
      slug,
      "completed",
      opts.channelName ?? "general",
      post,
      stored,
      opts.trigger ?? "unknown",
    ));
    posted = true;
  }
  const { anchor, details } = post;

  return {
    status: "ok",
    slug,
    sprintName: sprint.name,
    committed: result.committed,
    completed: result.completed,
    rate: result.rate,
    stuck: result.stuck.length,
    anchor,
    details,
    posted,
  };
}
