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
import { postMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { sprintAnchorKey, sprintThreadKey, type SendTrigger } from "./outboundKeys";
import { readSprint, writeSprint, type SprintRecord } from "./sprintStore";
import {
  buildCommittedPost,
  buildCompletedPost,
  computeCompletion,
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
  | { status: "no-active-sprint" }
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
  const anchorTs = await postMessage(channelId, plan.anchor, { ...meta, key: anchorKey });
  if (!anchorTs) {
    throw new Error(
      `sprint: no ts for the anchor post (key ${anchorKey}) — a stuck pending row holds the key; clear it before retrying.`,
    );
  }
  for (const [i, text] of plan.details.entries()) {
    const key = sprintThreadKey(kind, slug, channelName, i + 1);
    const ts = await postMessage(channelId, text, { ...meta, key }, anchorTs);
    if (!ts) {
      throw new Error(
        `sprint: detail reply ${i + 1}/${plan.details.length} was skipped with no ts (key ${key}) — a stuck pending row holds the key; clear it before retrying.`,
      );
    }
  }
  return { anchorTs, post: { anchor: plan.anchor, details: plan.details } };
}

/** Tuesday job: freeze the active sprint's issue set + post the Committed list. */
export async function runSprintCommit(opts: RunSprintOptions): Promise<CommitResult> {
  const boardId = boardIdFromEnv();
  const sprint = await resolveSprint(boardId, opts.sprintId);
  if (!sprint) return { status: "no-active-sprint" };

  const issues = await fetchSprintIssues(sprint.id);
  const snapshot: SprintSnapshot = {
    sprintId: sprint.id,
    sprintName: sprint.name,
    slug: slugifySprint(sprint.name),
    capturedAt: new Date().toISOString(),
    issues,
  };

  // Freeze the baseline. A fresh Tuesday snapshot for this sprint drops any stale
  // completed result (re-earned by the Monday report); same-day re-fire re-freezes.
  // Already-published plans survive, so a re-fire replays them instead of repacking.
  const prior = await readSprint(snapshot.slug);
  const record: SprintRecord = { committed: snapshot, published: prior?.published };
  await writeSprint(snapshot.slug, record);

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
    count: issues.length,
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
