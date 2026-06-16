import type { ContributorRow } from "@/lib/devStats";

/** Signed integer for the net column (e.g. +120, -8, 0). */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Contributor leaderboard — bot rows are tinted and badged. When `summaries` is
 * provided (committed reports carry per-contributor occupation summaries keyed
 * by ContributorRow.key), a Summary column is appended.
 */
export function ContributorTable({
  rows,
  summaries,
}: {
  rows: ContributorRow[];
  summaries?: Record<string, string>;
}) {
  const showSummary = summaries && Object.keys(summaries).length > 0;
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Pick a period and load activity to see contributors.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Contributor</th>
            <th className="px-3 py-2 text-right">Default-branch commits</th>
            <th className="px-3 py-2 text-right">+ Added</th>
            <th className="px-3 py-2 text-right">&minus; Deleted</th>
            <th className="px-3 py-2 text-right">Net</th>
            <th className="px-3 py-2 text-right">PRs opened</th>
            <th className="px-3 py-2 text-right">PRs merged</th>
            {showSummary && <th className="px-3 py-2">Summary</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={`border-b border-slate-100 last:border-0 ${
                row.isBot ? "bg-slate-50" : "hover:bg-slate-50"
              }`}
            >
              <td className="px-3 py-2 font-medium text-slate-900">
                {row.displayName}
                {row.isBot && (
                  <span className="ml-2 inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                    bot
                  </span>
                )}
                {row.unlinked && !row.isBot && (
                  <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    unlinked
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.commits}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                {row.additions}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-rose-700">
                {row.deletions}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {signed(row.net)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsOpened}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsMerged}
              </td>
              {showSummary && (
                <td className="px-3 py-2 text-xs text-slate-600">
                  {summaries?.[row.key] ?? ""}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
