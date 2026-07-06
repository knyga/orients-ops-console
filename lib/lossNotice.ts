/**
 * Pure tiered drone-loss alert planning (spec: every counter change → operator
 * DM; reaching TEAM_LOSS_CUTOFF → a one-time Ukrainian #field-qa warning).
 * The caller persists `next` ONLY after the sends succeed, so a failed send
 * retries next run (the outbound key dedups a half-delivered pair).
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
      ? `⚠️ Увага: у команді вже ${count} втрати бортів цього місяця. Ще одна втрата — і місячний бонус обнуляється для всіх.`
      : null;
  return {
    operatorDm,
    fieldQaWarning,
    next: { lastAlertedCount: count, fieldqaWarnedAt3: state.fieldqaWarnedAt3 || fieldQaWarning !== null },
  };
}
