/**
 * Pure recognizer: is there a #datasets notice for flight day D within the grace
 * window? A message counts when it (a) is posted in [D, windowEnd] (by day) and
 * (b) both reads like a dataset notice (keyword) and references D's date in any
 * common written form. An explicit "no dataset for D" note also counts (the team
 * may legitimately have nothing to publish that day).
 *
 * Recognition is intentionally conservative + evidence-surfacing — ambiguous
 * cases are confirmed by a human/LLM downstream, same posture as policy verdicts.
 * No imports; unit-tested.
 */
export interface NoticeMessage {
  isoTime: string;
  text: string;
}

// "датасет"/"dataset" (incl. Ukrainian cases), or an explicit "немає датасету".
const DATASET_KEYWORD = /датасет|dataset|немає\s+датасет/i;
const NO_DATASET = /немає\s+датасет|no\s+dataset/i;

/** All written forms of `date` (YYYY-MM-DD) a human might use. */
function dateNeedles(date: string): string[] {
  const [y, m, d] = date.split("-");
  return [
    `${y}-${m}-${d}`, // 2026-06-16
    `${d}.${m}.${y}`, // 16.06.2026
    `${d}.${m}`,      // 16.06
  ];
}

function referencesDate(text: string, date: string): boolean {
  return dateNeedles(date).some((needle) => text.includes(needle));
}

/**
 * @param messages #datasets messages (already restricted to that channel).
 * @param date flight day D (YYYY-MM-DD).
 * @param windowEnd inclusive last day a notice still counts (D + grace, YYYY-MM-DD).
 */
export function hasDatasetNotice(
  messages: NoticeMessage[],
  date: string,
  windowEnd: string,
): boolean {
  for (const m of messages) {
    const day = m.isoTime.slice(0, 10);
    if (day < date || day > windowEnd) continue;
    if (!referencesDate(m.text, date)) continue;
    if (DATASET_KEYWORD.test(m.text) || NO_DATASET.test(m.text)) return true;
  }
  return false;
}
