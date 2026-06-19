"use client";

import { useEffect, useState } from "react";

interface ReportDay {
  date: string;
  flightHours: number;
  airborneMinutes: number;
  flights: number;
  permalink: string;
}
interface FieldQaReport {
  period: { start: string; end: string; timezone: string };
  sourceChannel: string;
  days: ReportDay[];
  totals: { days: number; flightHours: number };
}

export default function FieldQaPage() {
  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<FieldQaReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/field-qa?periods=1")
      .then((r) => r.json())
      .then((b) => {
        const list: string[] = b.periods ?? [];
        setPeriods(list);
        if (list.length > 0) setSelected(list[0]);
      })
      .catch(() => setError("Failed to load committed periods."));
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/field-qa?period=${selected}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `Request failed (${r.status})`);
        setError(null);
        setReport(b as FieldQaReport);
      })
      .catch((e) => {
        setReport(null);
        setError(e instanceof Error ? e.message : "Failed to load report.");
      });
  }, [selected]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Field QA — Flight Hours
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Flight time = the stats-bot airborne time (Час в повітрі) read from the daily summary image in #field-qa. Review before it feeds reconciliation. Generate with{" "}
          <code className="text-slate-600">npm run field-qa -- --write</code>.
        </p>
      </div>

      {periods.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          Period
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            {periods.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {periods.length === 0 && !error && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          No committed reports yet. Run{" "}
          <code className="text-slate-600">npm run field-qa -- --write</code> to create one.
        </p>
      )}

      {report && (
        <section className="space-y-2">
          <div className="text-sm text-slate-500">
            {report.totals.days} days · {report.totals.flightHours} flight hours
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="py-1">Date</th>
                <th className="py-1">Hours</th>
                <th className="py-1">Airborne (min)</th>
                <th className="py-1">Flights</th>
                <th className="py-1">Source</th>
              </tr>
            </thead>
            <tbody>
              {report.days.map((d) => (
                <tr key={d.date} className="border-t border-slate-100">
                  <td className="py-1 tabular-nums">{d.date}</td>
                  <td className="py-1 tabular-nums">{d.flightHours}</td>
                  <td className="py-1 tabular-nums">{d.airborneMinutes}</td>
                  <td className="py-1 tabular-nums">{d.flights}</td>
                  <td className="py-1">
                    {d.permalink ? (
                      <a href={d.permalink} className="text-sky-600 hover:underline" target="_blank" rel="noreferrer">
                        Slack
                      </a>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
