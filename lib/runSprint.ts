/**
 * Shared sprint-completion orchestration, used by BOTH the `npm run sprint` CLI
 * and the two Vercel cron routes (mirrors lib/runNightly.ts). Server-side: pulls
 * the active sprint from Jira, freezes/loads the committed baseline, computes
 * completion, and (when publishing) posts to #general via the lib/slack.ts
 * reserve-then-send chokepoint.
 *
 * DRY-RUN aware: with `publish:false` it computes everything and returns the exact
 * message text without posting.
 */
import { boardIdFromEnv, fetchIssuesByKeys, fetchSprintIssues, listSprints, type Sprint } from "./jira";
import { postMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { sprintCommittedKey, sprintCompletedKey, type SendTrigger } from "./outboundKeys";
import { readSprint, writeSprint, type SprintRecord } from "./sprintStore";
import {
  computeCompletion,
  formatCommittedMessage,
  formatCompletedMessage,
  slugifySprint,
  type SprintSnapshot,
} from "./sprintReport";

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
      message: string;
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
      message: string;
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

/** Monday job: freeze the active sprint's issue set + post the Committed list. */
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

  // Freeze the baseline. A fresh Monday snapshot for this sprint drops any stale
  // completed result (re-earned on Sunday); same-day re-fire just re-freezes.
  const record: SprintRecord = { committed: snapshot };
  await writeSprint(snapshot.slug, record);

  const message = formatCommittedMessage(snapshot);
  let posted = false;
  if (opts.publish) {
    const channelName = opts.channelName ?? "general";
    await postMessage(channelIdByName(channelName), message, {
      key: sprintCommittedKey(snapshot.slug),
      feature: "sprint",
      channel: channelName,
      trigger: opts.trigger ?? "unknown",
    });
    posted = true;
  }

  return {
    status: "ok",
    slug: snapshot.slug,
    sprintName: snapshot.sprintName,
    count: issues.length,
    message,
    posted,
  };
}

/** Sunday job: measure the frozen baseline's completion + post the Completed report. */
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

  await writeSprint(slug, {
    committed: record.committed,
    completed: { computedAt: new Date().toISOString(), result },
  });

  const message = formatCompletedMessage(sprint.name, result);
  let posted = false;
  if (opts.publish) {
    const channelName = opts.channelName ?? "general";
    await postMessage(channelIdByName(channelName), message, {
      key: sprintCompletedKey(slug),
      feature: "sprint",
      channel: channelName,
      trigger: opts.trigger ?? "unknown",
    });
    posted = true;
  }

  return {
    status: "ok",
    slug,
    sprintName: sprint.name,
    committed: result.committed,
    completed: result.completed,
    rate: result.rate,
    stuck: result.stuck.length,
    message,
    posted,
  };
}
