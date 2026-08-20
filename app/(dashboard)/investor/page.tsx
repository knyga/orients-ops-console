"use client";

import { useEffect, useState } from "react";
import type { InvestorRecord } from "@/lib/investorReport";

export default function InvestorPage() {
  const [keys, setKeys] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [record, setRecord] = useState<InvestorRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/investor?periods=1")
      .then((r) => r.json())
      .then((body: { keys: string[] }) => {
        setKeys(body.keys);
        if (body.keys.length) setSelected(body.keys[0]);
      })
      .catch(() => setError("Failed to list report weeks."));
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/investor?period=${encodeURIComponent(selected)}`);
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setRecord(body as InvestorRecord);
      } catch (e) {
        if (cancelled) return;
        setRecord(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-semibold">Investor weekly</h1>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {keys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {!keys.length && !error && (
        <p className="text-sm text-gray-500">
          No weekly reports yet — the Tuesday cron (or `npm run investor`) writes the first one.
        </p>
      )}

      {record && (
        <>
          <p className="text-xs text-gray-500 mb-2">
            Generated {record.generatedAt.slice(0, 16).replace("T", " ")} · summary:{" "}
            {record.summarySource}
            {record.gitContext && (
              <>
                {" · git grounding: "}
                {record.gitContext.error
                  ? `unavailable (${record.gitContext.error})`
                  : `${record.gitContext.included.length} PRs, ${Math.round(record.gitContext.totalChars / 1000)}k chars${record.gitContext.truncated ? ", truncated" : ""}`}
              </>
            )}
          </p>
          <pre className="whitespace-pre-wrap rounded border bg-gray-50 p-4 text-sm leading-relaxed">
            {record.message}
          </pre>

          <h2 className="mt-6 mb-2 font-medium text-sm">Raw numbers</h2>
          <table className="text-sm border-collapse">
            <tbody>
              <tr><td className="pr-4 py-0.5 text-gray-500">Jira resolved / SP</td><td>{record.data.jira.resolved} / {record.data.jira.storyPoints}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Sprint</td><td>{record.data.sprint ? `${record.data.sprint.name}: ${record.data.sprint.rate}% (${record.data.sprint.completed}/${record.data.sprint.committed})` : "—"}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Польові дні (телеметрія ∪ Звіти)</td><td>{record.data.field.activeDays ?? "—"}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Виїзди-Звіти (accepted / flagged)</td><td>{record.data.field.reports} ({record.data.field.accepted} / {record.data.field.flagged})</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Field / air hours</td><td>{record.data.field.fieldHours} / {record.data.field.airHours}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Video</td><td>{record.data.video.count} videos, {record.data.video.minutes} min</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Dataset days</td><td>{record.data.datasets.noticeDays}</td></tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
