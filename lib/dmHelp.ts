/**
 * The bot's DM help reply. Info-only: a DM never mutates verdict data — real
 * changes happen when an authorized approver replies IN a verdict thread. This
 * text teaches that flow. Ukrainian, matching the team-facing convention (see
 * lib/verdictPublish.ts). Pure (no IO) so both the webhook and the `npm run
 * dm-help` CLI render the exact same message.
 */
export function formatDmHelp(): string {
  return [
    "👋 Привіт! Я бот польових звітів Orients.",
    "",
    "Щодня я публікую вердикти по льотних днях у каналі #field-qa (прийнято / на перевірку / виняток).",
    "",
    "Щоб щось змінити, авторизований керівник відповідає *у гілці конкретного вердикту* — не тут, у ЛП. Я можу:",
    "• 👥 виправити екіпаж (склад у полі) — напр. «екіпаж: Влад, Тарас»",
    "• ✅ прийняти або ❌ відхилити день — напр. «прийнято» / «відхилено, немає датасету»",
    "• ⏱️ виставити наліт у хвилинах — напр. «наліт 90 хв»",
    "",
    "Я підтверджу зміну в гілці й попрошу підтвердження («так»/👍) перед тим, як застосувати.",
  ].join("\n");
}
