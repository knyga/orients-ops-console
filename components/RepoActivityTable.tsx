import type { RepoRow } from "@/lib/devStats";

/** Most-active-repositories ranking, ordered by composite activity score. */
export function RepoActivityTable({ rows }: { rows: RepoRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Pick a period and load activity to see repository activity.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Repository</th>
            <th className="px-3 py-2 text-right">Default-branch commits</th>
            <th className="px-3 py-2 text-right">+ Added</th>
            <th className="px-3 py-2 text-right">&minus; Deleted</th>
            <th className="px-3 py-2 text-right">PRs opened</th>
            <th className="px-3 py-2 text-right">PRs merged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.repo}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="px-3 py-2 font-medium text-slate-900">
                {row.repo}
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
                {row.prsOpened}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsMerged}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
