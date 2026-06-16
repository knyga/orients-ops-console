"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VimeoVideo } from "@/lib/vimeo";
import {
  aggregateByDay,
  summarize,
  type DailyRecon,
  type PeriodSummary,
} from "@/lib/reconcile";
import { toFlightDays, type FlightHoursRow } from "@/lib/flightHours";
import { formatMinutes } from "@/lib/format";
import { FlightHoursEditor } from "@/components/FlightHoursEditor";
import { VideoTable } from "@/components/VideoTable";
import { ReconciliationTable } from "@/components/ReconciliationTable";

/** The committed reconciliation artifact shape (reports/field-ops/<key>.json). */
interface FieldOpsReport {
  period: { start: string; end: string; timezone: string };
  daily: DailyRecon[];
  summary: PeriodSummary;
  flightInputPath: string | null;
}

/** Sentinel period value for the interactive, unsaved live-editing mode. */
const LIVE = "live";

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
  // Committed side.
  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>(LIVE);
  const [committed, setCommitted] = useState<FieldOpsReport | null>(null);
  const [committedError, setCommittedError] = useState<string | null>(null);

  // Live side (the original interactive flow).
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(todayIso);
  const [flightRows, setFlightRows] = useState<FlightHoursRow[]>([]);
  const [videos, setVideos] = useState<VimeoVideo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idCounter = useRef(0);
  const nextId = () => `fh-${idCounter.current++}`;

  const isLive = selected === LIVE;

  const live = useMemo(() => {
    const reconVideos = (videos ?? []).map((v) => ({
      createdTime: v.created_time,
      durationSeconds: v.duration,
    }));
    const daily = aggregateByDay(reconVideos, toFlightDays(flightRows));
    return { daily, summary: summarize(daily) };
  }, [videos, flightRows]);

  const loadCommitted = useCallback(async (key: string) => {
    setCommittedError(null);
    setCommitted(null);
    try {
      const res = await fetch(`/api/field-ops?period=${encodeURIComponent(key)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setCommitted(body as FieldOpsReport);
    } catch (e) {
      setCommittedError(e instanceof Error ? e.message : "Failed to load report.");
    }
  }, []);

  // On mount: list committed periods and show the newest one if any.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/field-ops?periods=1");
        const body = await res.json();
        if (cancelled) return;
        const list: string[] = Array.isArray(body.periods) ? body.periods : [];
        setPeriods(list);
        if (list.length > 0) {
          setSelected(list[0]);
          void loadCommitted(list[0]);
        }
      } catch {
        if (!cancelled) setCommittedError("Failed to list committed reports.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCommitted]);

  function onSelect(value: string) {
    setSelected(value);
    if (value === LIVE) {
      setCommitted(null);
      setCommittedError(null);
    } else {
      void loadCommitted(value);
    }
  }

  async function fetchVideos() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ start, end, refresh: "1" });
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

  // What the summary cards + reconciliation table render.
  const view = isLive ? live : committed ? { daily: committed.daily, summary: committed.summary } : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Field Ops — Video Reconciliation
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Internal Vimeo is the source of truth. A flight day passes when recorded
          video covers at least 50% of flight time; otherwise it is flagged for a
          human decision (never auto-rejected). Committed reports are produced by
          <code className="mx-1 rounded bg-slate-100 px-1">npm run fieldops -- --write</code>
          from committed flight hours.
        </p>
      </div>

      {/* Period selector */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Report
            <select
              value={selected}
              onChange={(e) => onSelect(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            >
              {periods.map((key) => (
                <option key={key} value={key}>
                  Committed {key}
                </option>
              ))}
              <option value={LIVE}>Live (current month, unsaved)</option>
            </select>
          </label>
          {!isLive && committed && (
            <span className="text-xs text-slate-500">
              Source of record. To update, edit committed flight hours and re-run
              the CLI.
            </span>
          )}
        </div>
      </div>

      {/* Live editing controls (only in live mode). */}
      {isLive && (
        <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">
              Period (live, unsaved)
            </h3>
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

          <FlightHoursEditor rows={flightRows} onChange={setFlightRows} nextId={nextId} />
        </div>
      )}

      {(error || committedError) && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? committedError}
        </div>
      )}

      <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        Note: a flight&rsquo;s video may be uploaded up to one working day later.
        Rows are grouped by <strong>upload date</strong> (Europe/Kyiv), so a late
        upload can land on the day after the flight — committed current-month
        reports are provisional until late uploads settle.
      </p>

      {/* Period summary */}
      {view && (
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard label="Total videos" value={String(view.summary.totalVideos)} />
          <SummaryCard
            label="Total recorded minutes"
            value={formatMinutes(view.summary.totalRecordedMinutes)}
          />
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Flagged days
            </div>
            {view.summary.flaggedDays.length === 0 ? (
              <div className="mt-1 text-sm text-slate-500">None</div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {view.summary.flaggedDays.map((d) => (
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
        <h2 className="text-sm font-semibold text-slate-900">Daily reconciliation</h2>
        <ReconciliationTable rows={view?.daily ?? []} />
      </section>

      {/* Per-video table (live mode only — committed artifacts hold no raw videos). */}
      {isLive && (
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
