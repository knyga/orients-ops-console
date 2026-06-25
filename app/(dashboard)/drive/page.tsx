// app/(dashboard)/drive/page.tsx
"use client";

import { useEffect, useState } from "react";

interface DriveSource {
  id: string;
  url: string;
  type: "sheet" | "doc";
  dest: string;
  gid?: string;
}
interface DriveStateEntry {
  modifiedTime: string;
  pulledAt: string;
  dest: string;
}
interface CheckRow {
  id: string;
  stale: boolean;
  modifiedTime: string;
}
interface DriveResponse {
  sources: DriveSource[];
  state: Record<string, DriveStateEntry>;
  check?: CheckRow[];
}

export default function DriveSyncPage() {
  const [data, setData] = useState<DriveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = async (check: boolean) => {
    setError(null);
    if (check) setChecking(true);
    try {
      const res = await fetch(`/api/drive${check ? "?check=1" : ""}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body as DriveResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    (async () => {
      await load(false);
    })();
  }, []);

  const checkById = new Map(data?.check?.map((c) => [c.id, c]) ?? []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Drive Sync</h1>
        <button
          onClick={() => void load(true)}
          disabled={checking}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      <p className="text-sm text-slate-500">
        Drive is the source of truth. Snapshots are pulled by the CLI:{" "}
        <code className="rounded bg-slate-100 px-1">npm run drive -- pull</code>. This
        page is read-only.
      </p>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {data && data.sources.length === 0 && (
        <p className="text-sm text-slate-500">
          No sources yet. Add entries to <code>reports/drive/manifest.json</code>.
        </p>
      )}

      {data && data.sources.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Dest</th>
              <th className="py-2 pr-4">Last pulled</th>
              <th className="py-2 pr-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => {
              const st = data.state[s.id];
              const chk = checkById.get(s.id);
              return (
                <tr key={s.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium text-slate-900">
                    <a href={s.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {s.id}
                    </a>
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{s.type}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-slate-600">{s.dest}</td>
                  <td className="py-2 pr-4 text-slate-600">{st?.pulledAt ?? "never"}</td>
                  <td className="py-2 pr-4">
                    {chk ? (
                      chk.stale ? (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          stale
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                          up to date
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
