"use client";

import { useEffect, useState } from "react";

interface Issue {
  key: string;
  summary: string;
  assignee: { accountId: string; displayName: string } | null;
  statusName: string;
  statusCategory: string;
  sprintCount: number;
}
interface Snapshot {
  sprintId: number;
  sprintName: string;
  slug: string;
  capturedAt: string;
  issues: Issue[];
}
interface AssigneeGroup {
  accountId: string | null;
  displayName: string;
  issues: Issue[];
}
interface StuckIssue { key: string; summary: string; displayName: string; sprintCount: number }
interface CompletionResult {
  committed: number;
  completed: number;
  rate: number;
  byAssignee: AssigneeGroup[];
  stuck: StuckIssue[];
}
interface SprintRecord {
  committed: Snapshot;
  completed?: { computedAt: string; result: CompletionResult };
}

const UNASSIGNED = "Не призначено";

function groupCommitted(issues: Issue[]): AssigneeGroup[] {
  const map = new Map<string, AssigneeGroup>();
  for (const i of issues) {
    const id = i.assignee?.accountId ?? "__unassigned__";
    let g = map.get(id);
    if (!g) {
      g = { accountId: i.assignee?.accountId ?? null, displayName: i.assignee?.displayName ?? UNASSIGNED, issues: [] };
      map.set(id, g);
    }
    g.issues.push(i);
  }
  return [...map.values()].sort((a, b) => {
    if (a.accountId === null) return 1;
    if (b.accountId === null) return -1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export default function SprintPage() {
  const [slugs, setSlugs] = useState<string[]>([]);
  const [slug, setSlug] = useState<string>("");
  const [record, setRecord] = useState<SprintRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/sprint?sprints=1");
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setSlugs(body.slugs as string[]);
        if (body.slugs.length && !slug) setSlug(body.slugs[0]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/sprint?slug=${encodeURIComponent(slug)}`);
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setRecord(body as SprintRecord);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setRecord(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const completed = record?.completed?.result;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Sprint Completion</h1>
        <select
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        >
          {slugs.length === 0 && <option value="">No sprints yet</option>}
          {slugs.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {record && (
        <>
          <section className="space-y-1">
            <h2 className="text-lg font-medium">
              {record.committed.sprintName}
              {completed && (
                <span className="ml-2 text-slate-600">
                  — виконано {completed.completed}/{completed.committed} ({completed.rate}%)
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-500">
              Зафіксовано {new Date(record.committed.capturedAt).toLocaleString()} · {record.committed.issues.length} задач
            </p>
          </section>

          {completed && completed.stuck.length > 0 && (
            <section className="rounded-md border border-amber-300 bg-amber-50 p-3">
              <h3 className="mb-1 text-sm font-semibold text-amber-800">⚠️ Зависли (кілька спринтів)</h3>
              <ul className="space-y-0.5 text-sm text-amber-900">
                {completed.stuck.map((s) => (
                  <li key={s.key}>
                    <span className="font-mono">{s.key}</span> — {s.summary}{" "}
                    <span className="text-amber-700">({s.sprintCount} спринтів · {s.displayName})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">Взято в роботу (за виконавцем і статусом)</h3>
            {groupCommitted(record.committed.issues).map((g) => (
              <div key={g.accountId ?? "__unassigned__"} className="rounded-md border border-slate-200 p-3">
                <div className="mb-1 font-medium">{g.displayName}</div>
                <ul className="space-y-0.5 text-sm">
                  {g.issues.map((i) => {
                    const done = i.statusCategory.toLowerCase() === "done";
                    return (
                      <li key={i.key} className="flex items-baseline gap-2">
                        <span className={`rounded px-1 text-xs ${done ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>
                          {i.statusName}
                        </span>
                        <span className="font-mono text-xs">{i.key}</span>
                        <span>{i.summary}</span>
                        {i.sprintCount >= 2 && (
                          <span className="text-xs text-amber-600">· {i.sprintCount} спринтів</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
