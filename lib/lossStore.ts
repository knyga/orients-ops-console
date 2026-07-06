/**
 * Durable drone-loss ledger store over the `loss_records` + `loss_alerts`
 * Postgres tables. NOT server-only: the CLIs import it (like lib/resolutions.ts).
 * Precedence (instruction outranks extracted) is pure in lib/lossLedger; this
 * module only enforces it at write time.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { upsertWins, type LossRow } from "./lossLedger";

export type { LossRow } from "./lossLedger";

function toRow(r: typeof schema.lossRecords.$inferSelect): LossRow {
  return {
    date: r.date,
    reportTs: r.reportTs,
    lost: r.lost,
    found: r.found,
    note: r.note,
    source: r.source as LossRow["source"],
    crashTextHash: r.crashTextHash,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

/** All loss rows (every classified crash text, including lost=false). */
export async function readLossRecords(): Promise<LossRow[]> {
  const rows = await db.select().from(schema.lossRecords);
  return rows.map(toRow);
}

/** Insert or replace one row, honoring source precedence. Returns whether it landed. */
export async function upsertLossRecord(row: LossRow): Promise<boolean> {
  const existing = await db
    .select()
    .from(schema.lossRecords)
    .where(and(eq(schema.lossRecords.date, row.date), eq(schema.lossRecords.reportTs, row.reportTs)));
  if (!upsertWins(existing[0] ? toRow(existing[0]) : undefined, row)) return false;
  await db
    .insert(schema.lossRecords)
    .values(row)
    .onConflictDoUpdate({ target: [schema.lossRecords.date, schema.lossRecords.reportTs], set: row });
  return true;
}

export interface LossAlertState {
  lastAlertedCount: number;
  fieldqaWarnedAt3: boolean;
}

export async function readLossAlertState(period: string): Promise<LossAlertState | null> {
  const rows = await db.select().from(schema.lossAlerts).where(eq(schema.lossAlerts.period, period));
  return rows[0] ? { lastAlertedCount: rows[0].lastAlertedCount, fieldqaWarnedAt3: rows[0].fieldqaWarnedAt3 } : null;
}

export async function writeLossAlertState(period: string, state: LossAlertState): Promise<void> {
  const values = { period, lastAlertedCount: state.lastAlertedCount, fieldqaWarnedAt3: state.fieldqaWarnedAt3 };
  await db.insert(schema.lossAlerts).values(values).onConflictDoUpdate({ target: schema.lossAlerts.period, set: values });
}
