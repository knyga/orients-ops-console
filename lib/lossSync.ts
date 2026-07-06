/**
 * Hash-gated drone-loss ledger sync. SERVER-ONLY (Claude via lossExtract).
 * Parses the period's #field-qa Звіти from the Slack mirror and classifies ONLY
 * crash text that is new or edited since its stored sha256 — a normal run makes
 * zero Claude calls. Approver `instruction` rows are never touched. A classifier
 * failure keeps the previous row (never fabricate a recovery) and continues —
 * `syncLossLedger` surfaces that count as `failed` on its return value so a
 * caller (the nightly) can alert the operator instead of it being silently
 * swallowed into a log line.
 * Shared by the nightly (counter + alerts), computeVerdicts consumers via the
 * ledger, and computeBonusReport (the money math).
 */
import "server-only";
import { createHash } from "node:crypto";
import { extractLoss } from "./lossExtract";
import { readLossRecords, upsertLossRecord } from "./lossStore";
import { readChannelMessages } from "./slackMirror";
import { parseMonth } from "./fieldReports";
import { mergeAliases, readAliases } from "./rosterAliases";
import { SEED_ALIASES } from "./fieldRoster";
import type { LossRow } from "./lossLedger";
import type { Period } from "./period";

export function crashHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface LossSyncResult {
  /** ALL ledger rows post-sync. */
  rows: LossRow[];
  /** Звіти newly classified this run (hash miss/new, not held by an instruction). */
  classified: number;
  /** Звіти whose classify call threw — the previous ledger row (if any) was kept
   *  as-is; a nonzero count here means the ledger may be stale for that Звіт. */
  failed: number;
}

/** Sync the ledger for a period; returns all rows post-sync plus classify/fail counts. */
export async function syncLossLedger(
  period: Period,
  opts: { onLog?: (m: string) => void } = {},
): Promise<LossSyncResult> {
  const log = opts.onLog ?? (() => {});
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  const byKey = new Map((await readLossRecords()).map((r) => [`${r.date}#${r.reportTs}`, r]));

  let classified = 0;
  let failed = 0;
  for (const r of reports) {
    if (!r.crashText) continue;
    const key = `${r.flightDate}#${r.reportTs}`;
    const existing = byKey.get(key);
    if (existing?.source === "instruction") continue;
    const hash = crashHash(r.crashText);
    if (existing && existing.crashTextHash === hash) continue;
    try {
      const cls = await extractLoss(r.crashText);
      classified += 1;
      const row: LossRow = {
        date: r.flightDate,
        reportTs: r.reportTs,
        lost: cls.lost,
        found: cls.found,
        note: cls.note,
        source: "extracted",
        crashTextHash: hash,
        updatedAt: new Date().toISOString(),
        updatedBy: null,
      };
      if (await upsertLossRecord(row)) byKey.set(key, row);
    } catch (e) {
      failed += 1;
      log(`loss-sync: classify failed for ${key} — ${e instanceof Error ? e.message : String(e)} (keeping previous state)`);
    }
  }
  log(`loss-sync: ${classified} classified, ${failed} failed, ${byKey.size} ledger row(s)`);
  return { rows: [...byKey.values()], classified, failed };
}
