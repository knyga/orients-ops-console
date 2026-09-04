/**
 * Pure Ukrainian one-line echo of a classified confirm-first instruction — the
 * text the bot posts back so an approver can confirm the exact data change before
 * it is applied ("Зрозумів: <summary>. Підтвердьте …"). No DB/Next imports;
 * unit-tested. Names are shown as the approver wrote them.
 */
import type { InstructionClassification } from "./instructionClassifyPrompt";

const earlyPhrase = (early: boolean): string => (early ? "рахувати як ранній виїзд (+200)" : "без раннього виїзду");

export function renderProposalSummary(date: string, c: InstructionClassification): string {
  switch (c.axis) {
    case "crew": {
      const parts: string[] = [];
      if (c.roster && c.roster.length) parts.push(`склад ${date}: ${c.roster.join(", ")}`);
      else {
        if (c.add?.length) parts.push(`додати до складу ${date}: ${c.add.join(", ")}`);
        if (c.remove?.length) parts.push(`прибрати зі складу ${date}: ${c.remove.join(", ")}`);
      }
      if (c.early !== undefined) parts.push(earlyPhrase(c.early));
      return parts.join("; ") || `склад ${date}`;
    }
    case "eligibility": {
      const parts: string[] = [];
      if (c.counted?.length) parts.push(`зарахувати ${date}: ${c.counted.join(", ")}`);
      if (c.notCounted?.length) parts.push(`не рахувати ${date}: ${c.notCounted.join(", ")}`);
      if (c.early !== undefined) parts.push(earlyPhrase(c.early));
      return parts.join("; ") || `облік бонусу ${date}`;
    }
    case "day":
      return c.decision === "rejected" ? `відхилити день ${date}` : `прийняти день ${date} (виняток)`;
    case "dataset":
      return c.datasetStatus === "DECLINED"
        ? `датасет ${date}: відхилити причину`
        : `датасет ${date}: виняток (не потрібен)`;
    case "video":
      return `відео ${date}: зарахувати (виняток)`;
    case "airborne":
      return `час у повітрі ${date}: ${(c.airborneMinutes ?? 0).toFixed(0)} хв`;
    case "loss":
      return c.lossState === "found"
        ? `борт ${date}: знайдено (втрату знято)`
        : `борт ${date}: втрачено (не знайдено)`;
    default:
      return `зміна ${date}`;
  }
}
