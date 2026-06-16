"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared client logic for the hybrid "render committed artifacts, refresh live"
 * pages. It lists committed periods (`?periods=1`), loads a committed report
 * (`?period=<key>`), and can fetch the current month live (`?refresh=1&…`).
 *
 * Committed and live responses can have different shapes (e.g. GitHub commits a
 * shaped summary but the live route returns raw activity), so each page injects
 * `mapCommitted` / `mapLive` to normalise both into its render type `T`. Those
 * mappers + the live query builder are read through a ref so the effect/callback
 * dependency lists stay minimal.
 */
export interface PeriodReportConfig<T> {
  /** Feature segment of the API route, e.g. "jira" | "github" | "vimeo". */
  feature: string;
  /** Normalise a committed `?period=` response body into the render type. */
  mapCommitted: (body: unknown) => T;
  /** Normalise a live `?refresh=1` response body into the render type. */
  mapLive: (body: unknown) => T;
  /** Live query string (no leading `?`) for the current month [start, end]. */
  liveQuery: (period: { start: string; end: string }) => string;
  /** IANA timezone for deciding "current month"; defaults to UTC. */
  timeZone?: string;
}

export interface PeriodReport<T> {
  periods: string[];
  currentKey: string;
  selected: string | null;
  report: T | null;
  loading: boolean;
  error: string | null;
  /** Whether the selected period is the current month (live refresh allowed). */
  canRefresh: boolean;
  select: (key: string) => void;
  refreshLive: () => void;
}

/** Today's date as YYYY-MM-DD in `timeZone` (default UTC). */
function todayInZone(timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function usePeriodReport<T>(config: PeriodReportConfig<T>): PeriodReport<T> {
  const { feature } = config;
  const configRef = useRef(config);
  // Keep the latest mappers/query builder available to callbacks without
  // widening their dependency lists (updated after render, never during).
  useEffect(() => {
    configRef.current = config;
  });

  const today = todayInZone(config.timeZone);
  const currentKey = today.slice(0, 7);

  const [periods, setPeriods] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback(
    async (key: string) => {
      setLoading(true);
      setError(null);
      setSelected(key);
      try {
        const res = await fetch(`/api/${feature}?period=${encodeURIComponent(key)}`);
        const body = await res.json();
        if (res.status === 404) {
          setReport(null);
          setError(
            key === today.slice(0, 7)
              ? "No committed report for this month yet — Refresh live to fetch it."
              : body.error ?? "No committed report for this period.",
          );
          return;
        }
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        setReport(configRef.current.mapCommitted(body));
      } catch (e) {
        setReport(null);
        setError(e instanceof Error ? e.message : "Failed to load report.");
      } finally {
        setLoading(false);
      }
    },
    [feature, today],
  );

  const refreshLive = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(today.slice(0, 7));
    try {
      const query = configRef.current.liveQuery({
        start: `${today.slice(0, 7)}-01`,
        end: today,
      });
      const res = await fetch(`/api/${feature}?refresh=1&${query}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setReport(configRef.current.mapLive(body));
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "Failed to refresh live.");
    } finally {
      setLoading(false);
    }
  }, [feature, today]);

  // On mount (and if the feature changes), list committed periods and load the
  // newest one. With nothing committed, leave the current month selected so the
  // user can Refresh live.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/${feature}?periods=1`);
        const body = await res.json();
        if (cancelled) return;
        const list: string[] = Array.isArray(body.periods) ? body.periods : [];
        setPeriods(list);
        if (list.length > 0) {
          void select(list[0]);
        } else {
          setSelected(today.slice(0, 7));
        }
      } catch {
        if (!cancelled) setError("Failed to list committed reports.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [feature, select, today]);

  return {
    periods,
    currentKey,
    selected,
    report,
    loading,
    error,
    canRefresh: selected === currentKey,
    select,
    refreshLive,
  };
}
