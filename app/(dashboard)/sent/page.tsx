"use client";

import { useCallback, useEffect, useState } from "react";

interface SentRow {
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

interface SentReport {
  period: { start: string; end: string };
  count: number;
  summary: { total: number; byStatus: Record<string, number>; byFeature: Record<string, number> };
  messages: SentRow[];
}

const STATUS_CLS: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-800",
  pending: "bg-slate-100 text-slate-700",
  failed: "bg-red-100 text-red-800",
  skipped: "bg-amber-100 text-amber-800",
};

export default function SentPage() {
  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<SentReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`/api/sent?period=${encodeURIComponent(key)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(body as SentReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the outbound log.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sent?periods=1");
        const body = await res.json();
        if (cancelled) return;
        const list: string[] = Array.isArray(body.periods) ? body.periods : [];
        setPeriods(list);
        if (list.length > 0) {
          setSelected(list[0]);
          void load(list[0]);
        }
      } catch {
        if (!cancelled) setError("Failed to list periods.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Outbound messages</h1>
        {periods.length > 0 && (
          <select
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              void load(e.target.value);
            }}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {!error && periods.length === 0 && (
        <p className="text-sm text-slate-500">No outbound messages recorded yet.</p>
      )}

      {report && (
        <>
          <p className="text-sm text-slate-600">
            {report.count} message(s) ·{" "}
            {Object.entries(report.summary.byStatus)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Feature</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Origin</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2">Text</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.messages.map((m) => (
                  <tr key={m.key}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                      {(m.sentAt ?? m.reservedAt).replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          STATUS_CLS[m.status] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{m.feature}</td>
                    <td className="px-3 py-2 text-slate-500">{m.kind}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {m.origin}/{m.trigger}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-700">#{m.channel}</td>
                    <td className="px-3 py-2 text-slate-700">{m.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
