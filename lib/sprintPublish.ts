/**
 * Pure publication-plan logic for the sprint Slack posts.
 *
 * WHY a stored plan: the anchor + thread replies are deduped by positional keys
 * (`…:t1`, `…:t2`, …), but the `report` job re-fetches Jira live on every run — so
 * a retry after a partial send (a reply that failed, or a Vercel death mid-thread)
 * would repack DIFFERENT text into the same positions: `t1` dedups to the old
 * content while `t2` sends the repacked one, silently dropping or duplicating the
 * issues on the boundary. Freezing the exact texts on the first publish attempt
 * and replaying THEM makes every retry byte-identical, so positional keys are safe.
 *
 * Plans are per (kind, channel): publishing the same sprint to a test channel and
 * to #general are independent publications with independent keys.
 */
import type { SprintPost } from "./sprintReport";

export type SprintPostKind = "committed" | "completed";

export interface PublishedPlan extends SprintPost {
  kind: SprintPostKind;
  /** Tracked channel NAME the plan was frozen for. */
  channel: string;
  /** ISO timestamp of the first publish attempt. */
  plannedAt: string;
}

/** The frozen plan for this (kind, channel), or undefined when never published. */
export function findPlan(
  plans: PublishedPlan[] | undefined,
  kind: SprintPostKind,
  channel: string,
): PublishedPlan | undefined {
  return plans?.find((p) => p.kind === kind && p.channel === channel);
}

/** Insert or replace the plan for its (kind, channel), preserving the others. */
export function upsertPlan(
  plans: PublishedPlan[] | undefined,
  plan: PublishedPlan,
): PublishedPlan[] {
  const rest = (plans ?? []).filter((p) => !(p.kind === plan.kind && p.channel === plan.channel));
  return [...rest, plan];
}

/**
 * What to actually send: the frozen plan when this (kind, channel) was published
 * before (replay — byte-identical, so the dedup keys line up), else the freshly
 * computed post, which becomes the plan to freeze.
 */
export function resolvePlan(
  plans: PublishedPlan[] | undefined,
  kind: SprintPostKind,
  channel: string,
  fresh: SprintPost,
  now: string,
): { plan: PublishedPlan; replayed: boolean } {
  const stored = findPlan(plans, kind, channel);
  if (stored) return { plan: stored, replayed: true };
  return { plan: { ...fresh, kind, channel, plannedAt: now }, replayed: false };
}
