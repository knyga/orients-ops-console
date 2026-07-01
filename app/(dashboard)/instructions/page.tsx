"use client";

import { useEffect, useState } from "react";

interface Proposal {
  id: string;
  date: string;
  axis: string;
  summaryUk: string;
  proposedBy: string;
  state: string;
  createdAt: string;
}

interface CorrectionRow {
  date: string;
  axis: string;
  summary: string;
  by: string;
  source: string;
  recordedAt: string;
}

interface InstructionsReport {
  period: { start: string; end: string };
  pending: Proposal[];
  proposals: Proposal[];
  corrections: CorrectionRow[];
}

const STATE_CLS: Record<string, string> = {
  PROPOSED: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-slate-100 text-slate-600",
  SUPERSEDED: "bg-slate-100 text-slate-500",
};

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export default function InstructionsPage() {
  const [period, setPeriod] = useState<string>(currentMonth());
  const [report, setReport] = useState<InstructionsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/instructions?period=${encodeURIComponent(period)}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        setReport(body as InstructionsReport);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setReport(null);
        setError(e instanceof Error ? e.message : "Failed to load instructions.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Approver Instructions</h1>
        <input
          value={period}
          onChange={(e) => setPeriod(e.target.value.trim())}
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          placeholder="YYYY-MM"
          aria-label="Period"
        />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Confirm-first data-overwrite proposals from approver verdict-thread replies, and the corrections applied to
        this period. Read-only — changes flow through Slack (the bot echoes, an approver confirms) or the{" "}
        <code>field-instructions</code> CLI.
      </p>

      {error && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {!report && !error && <div className="text-sm text-slate-500">Loading…</div>}

      {report && (
        <>
          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Pending confirmation ({report.pending.length})
            </h2>
            {report.pending.length === 0 ? (
              <div className="text-sm text-slate-400">No proposals awaiting confirmation.</div>
            ) : (
              <ul className="space-y-2">
                {report.pending.map((p) => (
                  <li key={p.id} className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">
                    <span className="font-mono">{p.date}</span> · <span className="font-medium">{p.summaryUk}</span>{" "}
                    <span className="text-slate-500">— {p.proposedBy}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Applied corrections ({report.corrections.length})
            </h2>
            {report.corrections.length === 0 ? (
              <div className="text-sm text-slate-400">No corrections in this period.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-slate-500">
                      <th className="py-1 pr-4">Date</th>
                      <th className="py-1 pr-4">Axis</th>
                      <th className="py-1 pr-4">Change</th>
                      <th className="py-1 pr-4">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.corrections.map((c, i) => (
                      <tr key={`${c.date}-${c.axis}-${i}`} className="border-b border-slate-100">
                        <td className="py-1 pr-4 font-mono">{c.date}</td>
                        <td className="py-1 pr-4">{c.axis}</td>
                        <td className="py-1 pr-4">{c.summary}</td>
                        <td className="py-1 pr-4 text-slate-500">{c.by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {report.proposals.length > report.pending.length && (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">All proposals</h2>
              <ul className="space-y-1">
                {report.proposals.map((p) => (
                  <li key={p.id} className="text-sm">
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-xs ${STATE_CLS[p.state] ?? ""}`}>{p.state}</span>
                    <span className="font-mono">{p.date}</span> · {p.summaryUk}{" "}
                    <span className="text-slate-500">— {p.proposedBy}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
