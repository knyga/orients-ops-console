"use client";

import { usePeriodReport } from "@/lib/usePeriodReport";
import type { PeriodTotals, SprintChurnRow, UserRow } from "@/lib/jiraStats";

/** Committed reports may carry per-user summaries (keyed by accountId). */
interface JiraReport {
  rows: UserRow[];
  totals: PeriodTotals;
  sprintChurn: SprintChurnRow[];
  summaries?: Record<string, string>;
}

export default function DevReportingPage() {
  const {
    periods,
    currentKey,
    selected,
    report,
    loading,
    error,
    canRefresh,
    select,
    refreshLive,
  } = usePeriodReport<JiraReport>({
    feature: "jira",
    mapCommitted: (body) => body as JiraReport,
    mapLive: (body) => body as JiraReport,
    liveQuery: ({ start, end }) => `start=${start}&end=${end}`,
  });

  // The current month is selectable even before it's committed (live refresh).
  const options = periods.includes(currentKey) ? periods : [currentKey, ...periods];
  const hasSummaries = report?.summaries && Object.keys(report.summaries).length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Dev Reporting — Jira
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-user issues resolved (count and story points) plus sprint changes.
          Renders the committed report for the selected period; the current month
          can be refreshed against live Jira.
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Period
            <select
              value={selected ?? currentKey}
              onChange={(e) => select(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            >
              {options.map((key) => (
                <option key={key} value={key}>
                  {key}
                  {key === currentKey ? " (current)" : ""}
                  {!periods.includes(key) ? " — not committed" : ""}
                </option>
              ))}
            </select>
          </label>
          {canRefresh && (
            <button
              type="button"
              onClick={refreshLive}
              disabled={loading}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh live"}
            </button>
          )}
          {loading && <span className="text-xs text-slate-400">Loading…</span>}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
                      {hasSummaries && <th className="px-4 py-2">Summary</th>}
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
                        {hasSummaries && (
                          <td className="px-4 py-2 text-xs text-slate-600">
                            {row.accountId ? report.summaries?.[row.accountId] ?? "" : ""}
                          </td>
                        )}
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

      {!report && !error && !loading && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          No committed reports yet. Select the current month and Refresh live.
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
