"use client";

import type { OrgActivity } from "@/lib/githubClient";
import { summarize, type DevStatsSummary } from "@/lib/devStats";
import { usePeriodReport } from "@/lib/usePeriodReport";
import { ContributorTable } from "@/components/ContributorTable";
import { RepoActivityTable } from "@/components/RepoActivityTable";

/** Committed reports carry per-contributor summaries (keyed by contributor key). */
type GitHubReport = DevStatsSummary & { summaries?: Record<string, string> };

export default function GitHubReportingPage() {
  const {
    periods,
    currentKey,
    selected,
    report: summary,
    loading,
    error,
    canRefresh,
    select,
    refreshLive,
  } = usePeriodReport<GitHubReport>({
    feature: "github",
    // Committed reports are already the shaped summary; the live route returns
    // raw activity, so summarise it client-side (same as the original page).
    mapCommitted: (body) => body as GitHubReport,
    mapLive: (body) => summarize((body as { activity: OrgActivity }).activity),
    liveQuery: ({ start, end }) => `start=${start}&end=${end}`,
  });

  const options = periods.includes(currentKey) ? periods : [currentKey, ...periods];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          GitHub Activity
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Commits, pull requests and code landed on the default branch across
          active <strong>orients-ai</strong> repositories. Renders the committed
          report for the selected period; the current month can be refreshed
          against live GitHub. Day boundaries are UTC; bots are ranked after humans.
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

      {/* Period summary */}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Active repos" value={String(summary.totals.repos)} />
          <SummaryCard
            label="Contributors"
            value={String(summary.totals.contributors)}
          />
          <SummaryCard
            label="Default-branch commits"
            value={String(summary.totals.commits)}
          />
          <SummaryCard label="PRs merged" value={String(summary.totals.prsMerged)} />
        </div>
      )}

      {/* Contributors */}
      {summary && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">Contributors</h2>
          <ContributorTable rows={summary.contributors} summaries={summary.summaries} />
        </section>
      )}

      {/* Repositories */}
      {summary && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Most active repositories
          </h2>
          <RepoActivityTable rows={summary.repos} />
        </section>
      )}

      {!summary && !error && !loading && (
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
