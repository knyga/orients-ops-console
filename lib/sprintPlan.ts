/**
 * Pure "next sprint" planning: given the active sprint's name and the board's
 * future sprints, decide which sprint an issue should move to. "Next" means the
 * active sprint's trailing number + 1 (ATP 40 → ATP 41). An existing future
 * sprint is matched by that number (spacing/prefix drift tolerated — "ATP41"
 * still matches); absent a match, the plan is to create "<prefix> <n+1>" with
 * the active sprint's exact prefix. No number in the active name → null (the
 * caller reports it can't determine the next sprint).
 *
 * Pure — no server-only / node imports; the Agile API calls live in lib/jira.ts.
 */

export interface SprintRef {
  id: number;
  name: string;
}

export interface NextSprintPlan {
  /** Existing future sprint id, or null when it must be created first. */
  sprintId: number | null;
  sprintName: string;
  create: boolean;
}

const LAST_NUMBER = /(\d+)(?!.*\d)/;

/** The number the next sprint should carry, from the active sprint's name. */
export function nextSprintNumber(activeName: string): number | null {
  const m = activeName.match(LAST_NUMBER);
  return m ? Number(m[1]) + 1 : null;
}

export function planNextSprint(activeName: string, future: SprintRef[]): NextSprintPlan | null {
  const next = nextSprintNumber(activeName);
  if (next === null) return null;

  const existing = future.find((s) => {
    const m = s.name.match(LAST_NUMBER);
    return m !== null && Number(m[1]) === next;
  });
  if (existing) return { sprintId: existing.id, sprintName: existing.name, create: false };

  const name = activeName.replace(LAST_NUMBER, String(next));
  return { sprintId: null, sprintName: name, create: true };
}
