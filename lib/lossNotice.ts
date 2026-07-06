/**
 * Pure tiered drone-loss alert planning (spec: every counter change → operator
 * DM; reaching TEAM_LOSS_CUTOFF → a one-time Ukrainian #field-qa warning).
 * The caller persists `next` ONLY after the sends succeed, so a failed send
 * retries next run (the outbound key dedups a half-delivered pair). The
 * operator DM's outbound key must be built via `lossAlertDmKey` (below), which
 * salts it with the run date — the raw `count` alone is not a fresh key across
 * nights, since the counter can flip-flop back to a value already sent.
 */
import { TEAM_LOSS_CUTOFF } from "./fieldBonus";
import type { LossAlertState } from "./lossStore";

export interface LossAlertPlan {
  operatorDm: string | null;
  fieldQaWarning: string | null;
  next: LossAlertState;
}

function operatorDmText(count: number, prev: number, periodLabel: string): string {
  const status =
    count > TEAM_LOSS_CUTOFF
      ? `Місяць обнулено для всієї команди (понад ${TEAM_LOSS_CUTOFF} втрати).`
      : count === TEAM_LOSS_CUTOFF
        ? "Наступна втрата обнуляє місяць для всієї команди."
        : `Ліміт — ${TEAM_LOSS_CUTOFF} на місяць.`;
  return `🛸 Втрати бортів за ${periodLabel}: ${count} (було ${prev}). ${status}`;
}

export function planLossAlerts(count: number, prev: LossAlertState | null, periodLabel: string): LossAlertPlan {
  const state = prev ?? { lastAlertedCount: 0, fieldqaWarnedAt3: false };
  const operatorDm = count !== state.lastAlertedCount ? operatorDmText(count, state.lastAlertedCount, periodLabel) : null;
  const fieldQaWarning =
    count >= TEAM_LOSS_CUTOFF && !state.fieldqaWarnedAt3
      ? count > TEAM_LOSS_CUTOFF
        // The cutoff was already crossed before this warning fired (e.g. a
        // 2→4 jump) — the month is wiped now, not "one more loss away".
        ? `⚠️ Увага: у команді ${count} втрат бортів цього місяця — місячний бонус обнулено для всіх (понад ${TEAM_LOSS_CUTOFF}).`
        : `⚠️ Увага: у команді вже ${count} втрати бортів цього місяця. Ще одна втрата — і місячний бонус обнуляється для всіх.`
      : null;
  return {
    operatorDm,
    fieldQaWarning,
    next: { lastAlertedCount: count, fieldqaWarnedAt3: state.fieldqaWarnedAt3 || fieldQaWarning !== null },
  };
}

/** The (permanent) outbound-message key for one loss-count operator DM,
 *  salted with the run's Kyiv calendar day so a same-period counter flip-flop
 *  (e.g. 2→3→2→3 across two nights) still re-sends instead of being silently
 *  dropped by the dedup-on-`sent`-rows guard in reserveSend. */
export function lossAlertDmKey(periodLabel: string, count: number, runDate: string): string {
  return `loss-alert:${periodLabel}:${count}:${runDate}`;
}
