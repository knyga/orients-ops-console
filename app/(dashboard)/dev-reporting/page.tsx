"use client";

import { useState } from "react";
import type {
  PeriodTotals,
  SprintChurnRow,
  UserRow,
} from "@/lib/jiraStats";

interface JiraReport {
  rows: UserRow[];
  totals: PeriodTotals;
  sprintChurn: SprintChurnRow[];
}

/** First day of the current month, in `YYYY-MM-DD`. */
function defaultStart(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-01`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DevReportingPage() {
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(todayIso);
  const [report, setReport] = useState<JiraReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchReport() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ start, end });
      const res = await fetch(`/api/jira?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(body as JiraReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch report.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Dev Reporting — Jira
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-user issues resolved (count and story points) over the selected
          period, plus issues that changed sprints. Read-only; reflects live Jira.
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Period</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Start
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            End
            <input
              type="date"
              value={end}
              min={start}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={fetchReport}
            disabled={loading || !start || !end}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Fetching…" : "Fetch report"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {report && (
        <>
          {/* Period totals */}
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryCard label="Total resolved" value={String(report.totals.totalResolved)} />
            <SummaryCard
              label="Total story points"
              value={String(report.totals.totalStoryPoints)}
            />
          </div>

          {/* Per-user table */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900">Resolved by user</h2>
            {report.rows.length === 0 ? (
              <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
                No issues resolved in this period.
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2">User</th>
                      <th className="px-4 py-2 text-right">Resolved</th>
                      <th className="px-4 py-2 text-right">Story points</th>
                      <th className="px-4 py-2">Issues</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.rows.map((row) => (
                      <tr key={row.accountId ?? "unassigned"}>
                        <td className="px-4 py-2 text-slate-900">{row.displayName}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {row.resolvedCount}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {row.storyPoints}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500">
                          {row.issueKeys.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Sprint churn */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900">Sprint changes</h2>
            {report.sprintChurn.length === 0 ? (
              <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
                No issues changed sprints in this period.
              </p>
            ) : (
              <ul className="space-y-2">
                {report.sprintChurn.map((item) => (
                  <li
                    key={item.issueKey}
                    className="rounded-md border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="text-sm font-medium text-slate-900">
                      <span className="font-mono text-slate-500">{item.issueKey}</span>{" "}
                      {item.summary}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.changes.map((c, i) => (
                        <span
                          key={i}
                          className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                        >
                          {c.from || "—"} → {c.to || "—"}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {!report && !error && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          Pick a period and fetch the report to begin.
        </p>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}
