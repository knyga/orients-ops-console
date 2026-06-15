"use client";

import { useMemo, useState } from "react";
import type { OrgActivity } from "@/lib/githubClient";
import { summarize } from "@/lib/devStats";
import { ContributorTable } from "@/components/ContributorTable";
import { RepoActivityTable } from "@/components/RepoActivityTable";

/** `YYYY-MM-DD` for `days` ago in UTC. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function GitHubReportingPage() {
  const [start, setStart] = useState(() => isoDaysAgo(30));
  const [end, setEnd] = useState(todayIso);
  const [activity, setActivity] = useState<OrgActivity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(
    () => (activity ? summarize(activity) : null),
    [activity],
  );

  async function loadActivity() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ start, end });
      const res = await fetch(`/api/github?${params.toString()}`);
      const body = await res.json();
      if (!res.ok)
        throw new Error(body.error ?? `Request failed (${res.status})`);
      setActivity(body.activity as OrgActivity);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load activity.");
      setActivity(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          GitHub Activity
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Commits, pull requests and code landed on the default branch across
          active <strong>orients-ai</strong> repositories. Day boundaries are
          UTC. Bot accounts are flagged and ranked after humans.
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
            onClick={loadActivity}
            disabled={loading || !start || !end}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load activity"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
          <SummaryCard
            label="PRs merged"
            value={String(summary.totals.prsMerged)}
          />
        </div>
      )}

      {/* Contributors */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Contributors</h2>
        {summary === null ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            Pick a period and load activity to begin.
          </p>
        ) : (
          <ContributorTable rows={summary.contributors} />
        )}
      </section>

      {/* Repositories */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">
          Most active repositories
        </h2>
        {summary === null ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            Pick a period and load activity to begin.
          </p>
        ) : (
          <RepoActivityTable rows={summary.repos} />
        )}
      </section>
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
