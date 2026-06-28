"use client";

import { usePeriodReport } from "@/lib/usePeriodReport";
import type { BonusReport } from "@/lib/fieldBonus";

export default function FieldBonusPage() {
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
  } = usePeriodReport<BonusReport>({
    feature: "field-bonus",
    mapCommitted: (body) => body as BonusReport,
    mapLive: (body) => body as BonusReport,
    liveQuery: ({ start, end }) => `start=${start}&end=${end}`,
    timeZone: "Europe/Kyiv",
  });

  const options = periods.includes(currentKey) ? periods : [currentKey, ...periods];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Field Bonus
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Per-person field bonus breakdown (trips, early, weekend, gross, penalty, net).
          Renders the committed report for the selected period; the current month
          can be refreshed against live data.
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
          {/* Team-zeroed banner */}
          {report.teamZeroed && (
            <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              Team zeroed — more than 3 drones lost this period. All net bonuses are
              zero.
            </div>
          )}

          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              label="Total payout"
              value={`₴${report.total.toLocaleString("uk-UA")}`}
            />
            <SummaryCard label="People" value={String(report.people.length)} />
            <SummaryCard label="Flight days" value={String(report.days.length)} />
          </div>

          {/* Per-person table */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900">Per-person breakdown</h2>
            {report.people.length === 0 ? (
              <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
                No qualifying trips in this period.
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2">Person</th>
                      <th className="px-4 py-2 text-right">Trips</th>
                      <th className="px-4 py-2 text-right">Early</th>
                      <th className="px-4 py-2 text-right">Weekend</th>
                      <th className="px-4 py-2 text-right">Gross (₴)</th>
                      <th className="px-4 py-2 text-right">Penalty %</th>
                      <th className="px-4 py-2 text-right">Net (₴)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.people.map((p) => (
                      <tr key={p.name}>
                        <td className="px-4 py-2 text-slate-900">{p.name}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {p.trips}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {p.early}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {p.weekend}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {p.gross.toLocaleString("uk-UA")}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                          {p.penaltyPct === 0
                            ? "—"
                            : `${Math.round(p.penaltyPct * 100)}%`}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-900">
                          {p.net.toLocaleString("uk-UA")}
                        </td>
                      </tr>
                    ))}
                    {/* TOTAL row */}
                    <tr className="bg-slate-50 font-semibold">
                      <td className="px-4 py-2 text-slate-900">TOTAL</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {report.people.reduce((s, p) => s + p.trips, 0)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {report.people.reduce((s, p) => s + p.early, 0)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {report.people.reduce((s, p) => s + p.weekend, 0)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                        {report.people
                          .reduce((s, p) => s + p.gross, 0)
                          .toLocaleString("uk-UA")}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-400">—</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-900">
                        {report.total.toLocaleString("uk-UA")}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Penalties panel */}
          {report.penalties.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-900">Drone-loss penalties</h2>
              <ul className="space-y-2">
                {report.penalties.map((pen, i) => (
                  <li
                    key={i}
                    className="rounded-md border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                        -{Math.round(pen.pct * 100)}%
                      </span>
                      <span className="text-sm text-slate-700">
                        {pen.group.join(", ")}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{pen.reason}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Flags panel */}
          {report.flags.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-900">Flags</h2>
              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2">Kind</th>
                      <th className="px-4 py-2">Date</th>
                      <th className="px-4 py-2">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.flags.map((f, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2">
                          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            {f.kind}
                          </span>
                        </td>
                        <td className="px-4 py-2 tabular-nums text-slate-600">
                          {f.date}
                        </td>
                        <td className="px-4 py-2 text-slate-500">{f.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
