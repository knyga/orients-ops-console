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
interface IssueRef { key: string; summary: string }
interface AssigneeCompletion {
  accountId: string | null;
  displayName: string;
  committed: number;
  done: number;
  rate: number;
  doneByStatus: { status: string; issues: IssueRef[] }[];
  transitions: { from: string; to: string; issues: IssueRef[] }[];
  noProgress: { status: string; key: string; summary: string }[];
}
interface StuckIssue { key: string; summary: string; displayName: string; statusName?: string; sprintCount: number }
interface CompletionResult {
  committed: number;
  completed: number;
  rate: number;
  /** v2 records */
  assignees?: AssigneeCompletion[];
  /** legacy records (pre-v2) */
  byAssignee?: AssigneeGroup[];
  stuck: StuckIssue[];
}
interface ScopeIssue { key: string; summary: string; displayName: string; statusName: string }
interface ScopeChanges {
  added: ScopeIssue[];
  addedDone: number;
  removed: ScopeIssue[];
  unplanned: ScopeIssue[];
}
interface SprintRecord {
  committed: Snapshot;
  completed?: { computedAt: string; result: CompletionResult; scope?: ScopeChanges };
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

/** Issues of one scope group, grouped per assignee (server pre-sorts by owner). */
function ScopeGroup({ title, issues }: { title: string; issues: ScopeIssue[] }) {
  if (issues.length === 0) return null;
  const byOwner: { owner: string; issues: ScopeIssue[] }[] = [];
  for (const i of issues) {
    const last = byOwner[byOwner.length - 1];
    if (last && last.owner === i.displayName) last.issues.push(i);
    else byOwner.push({ owner: i.displayName, issues: [i] });
  }
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="mb-1 text-sm font-semibold text-slate-700">{title}</div>
      {byOwner.map((g) => (
        <div key={g.owner} className="mb-1">
          <div className="text-sm font-medium">{g.owner}</div>
          <ul className="space-y-0.5 text-sm">
            {g.issues.map((i) => (
              <li key={i.key} className="flex items-baseline gap-2">
                {i.statusName && (
                  <span className="rounded bg-slate-100 px-1 text-xs text-slate-600">{i.statusName}</span>
                )}
                <span className="font-mono text-xs">{i.key}</span>
                <span>{i.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
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
                    {s.statusName && (
                      <span className="mr-1 rounded bg-amber-100 px-1 text-xs">{s.statusName}</span>
                    )}
                    <span className="font-mono">{s.key}</span> — {s.summary}{" "}
                    <span className="text-amber-700">({s.sprintCount} спринтів · {s.displayName})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {record.completed?.scope &&
            (record.completed.scope.added.length > 0 ||
              record.completed.scope.removed.length > 0 ||
              record.completed.scope.unplanned.length > 0) && (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-700">Зміни обсягу (вся реальна робота)</h3>
                <ScopeGroup
                  title={`➕ Додано після коміту (виконано ${record.completed.scope.addedDone}/${record.completed.scope.added.length})`}
                  issues={record.completed.scope.added}
                />
                <ScopeGroup title="➖ Знято зі спринту" issues={record.completed.scope.removed} />
                <ScopeGroup title="🔧 Виконано поза спринтом" issues={record.completed.scope.unplanned} />
              </section>
            )}

          {completed?.assignees && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">Виконання (за виконавцем)</h3>
              {completed.assignees.map((a) => (
                <div key={a.accountId ?? "__unassigned__"} className="rounded-md border border-slate-200 p-3">
                  <div className="mb-1 font-medium">
                    {a.displayName}
                    <span className="ml-2 text-sm text-slate-600">— {a.done}/{a.committed} ({a.rate}%)</span>
                  </div>
                  <ul className="space-y-0.5 text-sm">
                    {a.doneByStatus.map((b) =>
                      b.issues.map((i) => (
                        <li key={i.key} className="flex items-baseline gap-2">
                          <span className="rounded bg-green-100 px-1 text-xs text-green-800">{b.status}</span>
                          <span className="font-mono text-xs">{i.key}</span>
                          <span>{i.summary}</span>
                        </li>
                      )),
                    )}
                    {a.transitions.map((t) =>
                      t.issues.map((i) => (
                        <li key={i.key} className="flex items-baseline gap-2">
                          <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">{t.from} → {t.to}</span>
                          <span className="font-mono text-xs">{i.key}</span>
                          <span>{i.summary}</span>
                        </li>
                      )),
                    )}
                    {a.noProgress.map((i) => (
                      <li key={i.key} className="flex items-baseline gap-2">
                        <span className="rounded bg-slate-100 px-1 text-xs text-slate-600">{i.status}</span>
                        <span className="font-mono text-xs">{i.key}</span>
                        <span>{i.summary}</span>
                        <span className="text-xs text-slate-400">· без прогресу</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
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
