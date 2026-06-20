"use client";

import { useCallback, useEffect, useState } from "react";
import type { DayVerdict, VerdictStatus } from "@/lib/fieldDayVerdict";

/** The committed verdict artifact shape (reports/field-verdict/<key>.json). */
interface VerdictReport {
  period: { start: string; end: string };
  runDate: string;
  graceWorkingDays: number;
  days: DayVerdict[];
  summary: {
    accepted: number;
    pending: number;
    needsReview: number;
    acceptedException: number;
    rejected: number;
  };
}

const STATUS_STYLE: Record<VerdictStatus, { icon: string; label: string; cls: string }> = {
  ACCEPTED: { icon: "✅", label: "Accepted", cls: "bg-emerald-100 text-emerald-800" },
  PENDING: { icon: "⏳", label: "Pending", cls: "bg-slate-100 text-slate-700" },
  NEEDS_REVIEW: { icon: "⚠️", label: "Needs review", cls: "bg-amber-100 text-amber-800" },
  ACCEPTED_EXCEPTION: { icon: "🟡", label: "Accepted (exception)", cls: "bg-yellow-100 text-yellow-800" },
  REJECTED: { icon: "⛔", label: "Rejected", cls: "bg-red-100 text-red-800" },
};

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export default function FieldVerdictPage() {
  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<VerdictReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: string) => {
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`/api/field-verdict?period=${encodeURIComponent(key)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(body as VerdictReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load report.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/field-verdict?periods=1");
        const body = await res.json();
        if (cancelled) return;
        const list: string[] = Array.isArray(body.periods) ? body.periods : [];
        setPeriods(list);
        if (list.length > 0) {
          setSelected(list[0]);
          void load(list[0]);
        }
      } catch {
        if (!cancelled) setError("Failed to list committed reports.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  function onSelect(value: string) {
    setSelected(value);
    void load(value);
  }

  const s = report?.summary;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Field Verdict — Bonus Acceptance
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-flight-day acceptance: a day is accepted when, within the grace
          window, recorded video is at least 50% of the bot&rsquo;s airborne time
          AND a #datasets notice exists. Misses become &ldquo;needs review&rdquo;
          (never auto-rejected). Produced by
          <code className="mx-1 rounded bg-slate-100 px-1">npm run field-verdict -- --write</code>.
        </p>
      </div>

      {/* Period selector */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Report
          {periods.length === 0 ? (
            <span className="text-sm text-slate-500">
              No committed reports yet — run the CLI with <code>--write</code>.
            </span>
          ) : (
            <select
              value={selected}
              onChange={(e) => onSelect(e.target.value)}
              className="w-fit rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            >
              {periods.map((key) => (
                <option key={key} value={key}>
                  Committed {key}
                </option>
              ))}
            </select>
          )}
        </label>
        {report && (
          <p className="mt-2 text-xs text-slate-500">
            As of {report.runDate} · grace {report.graceWorkingDays} working days
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Summary cards */}
      {s && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryCard label="Accepted" value={String(s.accepted)} accent="text-emerald-700" />
          <SummaryCard label="Pending" value={String(s.pending)} accent="text-slate-700" />
          <SummaryCard label="Needs review" value={String(s.needsReview)} accent="text-amber-700" />
          <SummaryCard label="Accepted (exception)" value={String(s.acceptedException)} accent="text-yellow-700" />
          <SummaryCard label="Rejected" value={String(s.rejected)} accent="text-red-700" />
        </div>
      )}

      {/* Daily verdicts */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Daily verdicts</h2>
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Airborne (m)</th>
                <th className="px-3 py-2 text-right">Video (m)</th>
                <th className="px-3 py-2 text-right">Ratio</th>
                <th className="px-3 py-2 text-center">Dataset</th>
                <th className="px-3 py-2">Reasons</th>
              </tr>
            </thead>
            <tbody>
              {!report || report.days.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                    {report ? "No flight days in this period." : "Select a committed report."}
                  </td>
                </tr>
              ) : (
                report.days.map((d) => {
                  const st = STATUS_STYLE[d.status];
                  return (
                    <tr key={d.date} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2 tabular-nums text-slate-900">{d.date}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>
                          {st.icon} {st.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmt(d.airborneMinutes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmt(d.videoMinutes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {d.ratio === null ? "—" : `${(d.ratio * 100).toFixed(0)}%`}
                      </td>
                      <td className="px-3 py-2 text-center">{d.datasetPosted ? "✓" : "✗"}</td>
                      <td className="px-3 py-2 text-slate-500">{d.reasons.join("; ")}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}
