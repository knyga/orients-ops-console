import { describe, it, expect } from "vitest";
import { isFakeConfirmAsk } from "./fakeConfirm";

describe("isFakeConfirmAsk", () => {
  it("matches the classic proposal-echo tail «Продовжити? (так/ні)»", () => {
    expect(isFakeConfirmAsk("📝 Переведу ATP-1891 у статус Done.\nПродовжити? (так/ні)")).toBe(true);
  });

  it("matches a bare «(так/ні)» anywhere", () => {
    expect(isFakeConfirmAsk("Створити задачу? (так / ні) — чекаю")).toBe(true);
  });

  it("matches a trailing confirm question without the (так/ні) suffix", () => {
    expect(isFakeConfirmAsk("📝 Створю задачу для Тараса.\nПідтвердити?")).toBe(true);
    expect(isFakeConfirmAsk("Додати коментар до ATP-5?")).toBe(true);
  });

  it("does not match ordinary answers", () => {
    expect(isFakeConfirmAsk("Задача ATP-1891 вже в статусі Done.")).toBe(false);
    expect(isFakeConfirmAsk("За сьогодні закрито 3 задачі: ATP-1, ATP-2, ATP-3.")).toBe(false);
  });

  it("does not match a mid-answer question that is not a confirm ask", () => {
    expect(isFakeConfirmAsk("Не знайшов людину «Петро» в реєстрі — уточніть, будь ласка, кого призначити?")).toBe(false);
  });
});
