"use client";

import { useEffect, useState } from "react";

interface Loss { date: string; found: boolean; note: string }
interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
interface LossReport {
  period: { start: string; end: string };
  losses: Loss[];
  unrecovered: number;
  cutoff: number;
  teamZeroed: boolean;
  penalties: Penalty[];
}

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export default function LossesPage() {
  const [period, setPeriod] = useState<string>(currentMonth());
  const [report, setReport] = useState<LossReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/field-loss?period=${encodeURIComponent(period)}`);
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setReport(body as LossReport);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setReport(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [period]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Drone Losses</h1>
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {report && (
        <>
          <div className="rounded border border-slate-200 p-4">
            <p className="text-sm">
              Unrecovered losses: <span className="font-semibold">{report.unrecovered}</span> / {report.cutoff} allowed
              {report.teamZeroed && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-red-800">TEAM ZEROED (&gt;{report.cutoff})</span>}
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-1 pr-4">Date</th><th className="py-1 pr-4">State</th><th className="py-1">Note</th>
              </tr>
            </thead>
            <tbody>
              {report.losses.map((l) => (
                <tr key={l.date} className="border-b border-slate-100">
                  <td className="py-1 pr-4">{l.date}</td>
                  <td className="py-1 pr-4">{l.found ? "✅ found" : "⚠️ lost"}</td>
                  <td className="py-1">{l.note}</td>
                </tr>
              ))}
              {report.losses.length === 0 && (
                <tr><td colSpan={3} className="py-2 text-slate-500">No losses in this period.</td></tr>
              )}
            </tbody>
          </table>
          {report.penalties.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm">
              {report.penalties.map((p, i) => (
                <p key={i}>Crew {p.group.join(" + ")}: −{p.pct * 100}% ({p.reason})</p>
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}
