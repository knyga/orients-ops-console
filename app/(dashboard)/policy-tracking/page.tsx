"use client";

import { usePeriodReport } from "@/lib/usePeriodReport";
import type { CandidateMessage, OccurrenceStatus, SkippedObligation } from "@/lib/policySchedule";

type Verdict = "DONE" | "LATE" | "PARTIAL" | "MISSING";

interface OccurrenceReport {
  id: string;
  obligationId: string;
  title: string;
  channel: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  status: OccurrenceStatus;
  candidates: CandidateMessage[];
  verdict?: Verdict;
  rationale?: string;
}

interface PolicyReport {
  period: { start: string; end: string };
  runDate: string;
  occurrences: OccurrenceReport[];
  skipped: SkippedObligation[];
}

const BADGE: Record<string, string> = {
  DONE: "bg-emerald-100 text-emerald-800",
  LATE: "bg-amber-100 text-amber-800",
  PARTIAL: "bg-amber-100 text-amber-800",
  MISSING: "bg-rose-100 text-rose-800",
  NEEDS_REVIEW: "bg-slate-100 text-slate-700",
  PENDING: "bg-slate-100 text-slate-500",
};

export default function PolicyTrackingPage() {
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
  } = usePeriodReport<PolicyReport>({
    feature: "policy",
    mapCommitted: (body) => body as PolicyReport,
    mapLive: (body) => body as PolicyReport,
    liveQuery: ({ start, end }) => `start=${start}&end=${end}`,
  });

  const options = periods.includes(currentKey) ? periods : [currentKey, ...periods];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Policy Tracking
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-obligation execution status from the tracked Slack channels. Renders
          the committed report (with verdicts) for the selected period; the current
          month can be refreshed against live Slack (deterministic status only).
        </p>
      </div>

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
          <p className="text-xs text-slate-400">
            As of {report.runDate} · {report.period.start} … {report.period.end}
          </p>

          {report.occurrences.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
              No scheduled occurrences in this period.
            </p>
          ) : (
            <ul className="space-y-2">
              {report.occurrences.map((o) => (
                <li key={o.id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[o.verdict ?? o.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {o.verdict ?? o.status}
                    </span>
                    <span className="font-mono text-xs text-slate-500">{o.dueDate}</span>
                    <span className="text-sm font-medium text-slate-900">{o.title}</span>
                    <span className="text-xs text-slate-400">#{o.channel}</span>
                  </div>
                  {o.rationale && (
                    <p className="mt-1 text-xs text-slate-600">{o.rationale}</p>
                  )}
                  {o.candidates.length > 0 && (
                    <ul className="mt-2 space-y-1 border-l border-slate-100 pl-3">
                      {o.candidates.map((c, i) => (
                        <li key={i} className="text-xs text-slate-500">
                          <span className="font-medium text-slate-700">{c.author}</span>{" "}
                          <span className="text-slate-400">{c.isoTime.slice(0, 16).replace("T", " ")}</span>
                          {" — "}
                          {c.permalink ? (
                            <a href={c.permalink} className="text-sky-600 hover:underline" target="_blank" rel="noreferrer">
                              {c.excerpt}
                            </a>
                          ) : (
                            c.excerpt
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          {report.skipped.length > 0 && (
            <section className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-900">Not scheduled (v1)</h2>
              <ul className="text-xs text-slate-500">
                {report.skipped.map((s) => (
                  <li key={s.obligationId}>
                    {s.obligationId} — {s.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
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
