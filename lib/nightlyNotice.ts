/**
 * Pure formatting for the nightly field pipeline's operator failure DM. When a
 * stage of /api/cron/field-nightly throws (or an anomaly is detected) the cron
 * DMs the operator so a hands-off failure is not silent. Ukrainian, terse. No
 * imports — unit-tested.
 */
const MAX_REASON = 240;

export function formatNightlyFailureNotice(stage: string, reason: string): string {
  const trimmed = reason.trim().slice(0, MAX_REASON) || "невідома помилка";
  return `⚠️ Нічний польотний конвеєр збійнув на етапі «${stage}»: ${trimmed}. Публікацію зупинено; перевірте логи Vercel.`;
}
