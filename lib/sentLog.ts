/**
 * Pure shaping for the outbound-message record — the shared render source for the
 * `npm run sent` CLI and the /api/sent web tab. No DB/Next imports (OutboundRow is
 * a type-only import, erased at runtime).
 */
import type { OutboundRow } from "./outbound";

export interface SentRow {
  key: string;
  sentAt: string | null;
  reservedAt: string;
  feature: string;
  kind: string;
  channel: string;
  status: string;
  origin: string;
  trigger: string;
  text: string;
  ts: string | null;
  threadTs: string | null;
}

export interface SentSummary {
  total: number;
  byStatus: Record<string, number>;
  byFeature: Record<string, number>;
}

/** Project DB rows to the view type, newest first (sentAt, then reservedAt). */
export function toSentView(rows: OutboundRow[]): SentRow[] {
  return [...rows]
    .map((r) => ({
      key: r.key,
      sentAt: r.sentAt,
      reservedAt: r.reservedAt,
      feature: r.feature,
      kind: r.kind,
      channel: r.channel,
      status: r.status,
      origin: r.origin,
      trigger: r.trigger,
      text: r.text,
      ts: r.ts,
      threadTs: r.threadTs,
    }))
    .sort((a, b) => (b.sentAt ?? b.reservedAt).localeCompare(a.sentAt ?? a.reservedAt));
}

export function summarizeSent(rows: SentRow[]): SentSummary {
  const byStatus: Record<string, number> = {};
  const byFeature: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byFeature[r.feature] = (byFeature[r.feature] ?? 0) + 1;
  }
  return { total: rows.length, byStatus, byFeature };
}
