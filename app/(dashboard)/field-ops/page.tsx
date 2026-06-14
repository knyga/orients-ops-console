"use client";

import { useMemo, useRef, useState } from "react";
import type { VimeoVideo } from "@/lib/vimeo";
import { aggregateByDay, summarize } from "@/lib/reconcile";
import { toFlightDays, type FlightHoursRow } from "@/lib/flightHours";
import { formatMinutes } from "@/lib/format";
import { FlightHoursEditor } from "@/components/FlightHoursEditor";
import { VideoTable } from "@/components/VideoTable";
import { ReconciliationTable } from "@/components/ReconciliationTable";

/** First day of the current month, in `YYYY-MM-DD`. */
function defaultStart(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${now.getFullYear()}-${month}-01`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FieldOpsPage() {
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(todayIso);
  const [flightRows, setFlightRows] = useState<FlightHoursRow[]>([]);
  const [videos, setVideos] = useState<VimeoVideo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idCounter = useRef(0);
  const nextId = () => `fh-${idCounter.current++}`;

  const { daily, summary } = useMemo(() => {
    const reconVideos = (videos ?? []).map((v) => ({
      createdTime: v.created_time,
      durationSeconds: v.duration,
    }));
    const daily = aggregateByDay(reconVideos, toFlightDays(flightRows));
    return { daily, summary: summarize(daily) };
  }, [videos, flightRows]);

  async function fetchVideos() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ start, end });
      const res = await fetch(`/api/vimeo?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setVideos(body.videos as VimeoVideo[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch videos.");
      setVideos(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Field Ops — Video Reconciliation
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Internal Vimeo is the source of truth. A flight day passes when recorded
          video covers at least 50% of flight time; otherwise it is flagged for a
          human decision (never auto-rejected).
        </p>
      </div>

      {/* Controls */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
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
              onClick={fetchVideos}
              disabled={loading || !start || !end}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Fetching…" : "Fetch videos"}
            </button>
          </div>
        </div>

        <FlightHoursEditor
          rows={flightRows}
          onChange={setFlightRows}
          nextId={nextId}
        />
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        Note: a flight&rsquo;s video may be uploaded up to one working day later.
        Rows are grouped by <strong>upload date</strong> (Europe/Kyiv), so a late
        upload can land on the day after the flight.
      </p>

      {/* Period summary */}
      {videos && (
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard label="Total videos" value={String(summary.totalVideos)} />
          <SummaryCard
            label="Total recorded minutes"
            value={formatMinutes(summary.totalRecordedMinutes)}
          />
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Flagged days
            </div>
            {summary.flaggedDays.length === 0 ? (
              <div className="mt-1 text-sm text-slate-500">None</div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {summary.flaggedDays.map((d) => (
                  <span
                    key={d}
                    className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-800"
                  >
                    {d}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Daily reconciliation */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">
          Daily reconciliation
        </h2>
        <ReconciliationTable rows={daily} />
      </section>

      {/* Per-video table */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Videos</h2>
        {videos === null ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            Pick a period and fetch videos to begin.
          </p>
        ) : (
          <VideoTable videos={videos} />
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
