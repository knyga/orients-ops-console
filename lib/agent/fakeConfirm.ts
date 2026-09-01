/**
 * Detection + recovery text for HALLUCINATED confirmation asks (2026-09-01,
 * ATP-1891): the model can answer with plain TEXT that imitates a write
 * proposal's echo («Переведу … Продовжити? (так/ні)») without calling the
 * write tool — no PENDING row exists, so the user's «так» goes nowhere. Worse,
 * the fake lands in agent memory (agent_threads) and every later identical
 * request few-shot-imitates it instead of calling the tool — a self-
 * reinforcing trap. The system prompt forbids fakes; prompts are not
 * enforcement, so the surfaces use this module to detect (isFakeConfirmAsk),
 * retry with a corrective turn (slackTurn), warn the user (run route), and
 * keep the fake OUT of memory (run route stores the marker instead).
 *
 * Pure module — no imports, safe everywhere.
 */

const FAKE_CONFIRM_RE =
  // \b is ASCII-only in JS and never fires between Cyrillic letters — use a
  // Unicode letter lookahead instead of a word boundary.
  /\(\s*так\s*\/\s*ні\s*\)|(продовжити|підтвердити|застосувати|створити|додати)(?!\p{L})[^?\n]*\?\s*$/iu;

/** True when a plain-text answer reads like a confirm-first proposal echo.
 *  Only ever applied to kind "text" results — a real proposal's echo matches
 *  too, by design (it IS the pattern being imitated). */
export function isFakeConfirmAsk(text: string): boolean {
  return FAKE_CONFIRM_RE.test(text.trim());
}

/** Stamped under a fake ask the user will see, so «так» is never typed at a
 *  confirmation that does not exist. */
export const FAKE_CONFIRM_WARNING_UK =
  "⚠️ Це лише текст, не пропозиція: жодної дії не заплановано, «так» нічого не виконає. Згадайте мене із запитом ще раз.";

/** Stored in agent memory INSTEAD of the fake text — the verbatim fake in the
 *  transcript is what teaches the model to fake again on the next turn. */
export const FAKE_CONFIRM_MEMORY_UK =
  "(відповідь була імітацією підтвердження без виклику інструмента — дію не заплановано; для реальної зміни треба викликати інструмент запису)";

/** The corrective user turn for the one-shot retry: name the violation, demand
 *  the tool call. */
export const FAKE_CONFIRM_CORRECTION_UK =
  "СИСТЕМНЕ ЗАУВАЖЕННЯ: твоя попередня відповідь імітувала підтвердження звичайним текстом, без виклику інструмента — це заборонено. Якщо запит користувача вимагає зміни (Jira, календар, спринт) — ВИКЛИЧ відповідний інструмент запису зараз. Якщо зміна не потрібна — дай відповідь без «Продовжити? (так/ні)».";
