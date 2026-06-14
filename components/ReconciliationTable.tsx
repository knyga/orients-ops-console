import type { DailyRecon } from "@/lib/reconcile";
import { formatMinutes, formatRatio } from "@/lib/format";

function StatusBadge({ status }: { status: DailyRecon["status"] }) {
  if (status === "OK") {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        OK
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
      FLAG
    </span>
  );
}

/** Daily reconciliation table — FLAG rows are tinted amber to stand out. */
export function ReconciliationTable({ rows }: { rows: DailyRecon[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Add flight hours or fetch videos to see daily reconciliation.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2 text-right">Videos</th>
            <th className="px-3 py-2 text-right">Recorded min</th>
            <th className="px-3 py-2 text-right">Flight min</th>
            <th className="px-3 py-2 text-right">Ratio</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.date}
              className={`border-b border-slate-100 last:border-0 ${
                row.status === "FLAG" ? "bg-amber-50" : "hover:bg-slate-50"
              }`}
            >
              <td className="px-3 py-2 font-medium tabular-nums text-slate-900">
                {row.date}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.videoCount}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {formatMinutes(row.recordedMinutes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {formatMinutes(row.flightMinutes)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {formatRatio(row.ratio)}
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
