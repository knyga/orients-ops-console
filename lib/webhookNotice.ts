/**
 * Pure formatting for the Slack events webhook's failure notice — the visible
 * thread reply the bot posts when it RECOGNISED an actionable reply (an approver
 * override or an answer to one of its questions) but the effect threw.
 *
 * Without this, such a failure was swallowed behind an HTTP 200 whose body Slack
 * ignores: the bot stayed silent and looked like it simply hadn't reacted (the
 * exact symptom of the missing-ANTHROPIC_API_KEY incident). Posting a short
 * notice in the thread surfaces the failure to the people who live there, and
 * names the cause. No imports — unit-tested.
 */

/** Max chars of the underlying error to surface in-channel (keep it terse). */
const MAX_REASON = 240;

/** The thread reply the bot posts when an actionable reply failed to apply. */
export function formatWebhookFailureNotice(reason: string): string {
  const trimmed = reason.trim().slice(0, MAX_REASON) || "невідома помилка";
  return `⚠️ Не вдалося застосувати автоматично — помилка сервера: ${trimmed}. Її залоговано для оператора; я не оброблятиму цю відповідь, доки це не виправлять.`;
}
