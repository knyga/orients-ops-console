// app/(dashboard)/people/page.tsx
"use client";

import { useEffect, useState } from "react";
import type { PersonView } from "@/lib/who";

function currentKyivMonthKey(): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return ymd.slice(0, 7);
}

export default function PeoplePage() {
  const [people, setPeople] = useState<string[]>([]);
  const [person, setPerson] = useState<string>("");
  const [period, setPeriod] = useState<string>(currentKyivMonthKey());
  const [view, setView] = useState<PersonView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/who?people=1")
      .then((r) => r.json())
      .then((d: { people: string[] }) => {
        setPeople(d.people);
        if (d.people.length && !person) setPerson(d.people[0]);
      })
      .catch(() => setError("Failed to load people."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    if (!person) return;
    let cancelled = false;
    (async () => {
      setError(null);
      setView(null);
      try {
        const r = await fetch(`/api/who?person=${encodeURIComponent(person)}&period=${encodeURIComponent(period)}`);
        if (cancelled) return;
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(body.error ?? `HTTP ${r.status}`); return; }
        setView(body as PersonView);
      } catch {
        if (!cancelled) setError("Failed to load view.");
      }
    })();
    return () => { cancelled = true; };
  }, [person, period]);

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">People</h1>
      <div className="flex gap-3 items-center">
        <select className="border rounded px-2 py-1" value={person} onChange={(e) => setPerson(e.target.value)}>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input className="border rounded px-2 py-1" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {view && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <section className="md:col-span-2">
            <h2 className="font-medium mb-2">Timeline</h2>
            <ul className="space-y-1 text-sm">
              {view.timeline.length === 0 && <li className="text-gray-500">No messages.</li>}
              {view.timeline.map((t) => (
                <li key={t.ts} className="flex gap-2">
                  <span className="text-gray-500 tabular-nums">{t.isoTime.slice(0, 16).replace("T", " ")}</span>
                  <a className="text-blue-600 shrink-0" href={t.permalink} target="_blank" rel="noreferrer">#{t.channel}</a>
                  <span>{t.text}</span>
                </li>
              ))}
            </ul>
          </section>

          <aside className="space-y-3">
            <h2 className="font-medium">Summary</h2>
            {view.summary.jira && (
              <div className="border rounded p-3 text-sm">
                <div className="font-medium">Jira</div>
                <div>{view.summary.jira.count} issues · {view.summary.jira.points} pts</div>
                <div className="text-gray-500 break-words">{view.summary.jira.issueKeys.join(", ")}</div>
              </div>
            )}
            {view.summary.github && (
              <div className="border rounded p-3 text-sm">
                <div className="font-medium">GitHub</div>
                <div>{view.summary.github.commits} commits · +{view.summary.github.additions} −{view.summary.github.deletions}</div>
                <div>{view.summary.github.prsOpened} PRs opened · {view.summary.github.prsMerged} merged</div>
              </div>
            )}
            {view.summary.field && (
              <div className="border rounded p-3 text-sm">
                <div className="font-medium">Field</div>
                <div>{view.summary.field.trips} trips · {view.summary.field.flightDays} days · {view.summary.field.flightMinutes} min</div>
                <div>₴{view.summary.field.netUah}</div>
              </div>
            )}
            {!view.summary.jira && !view.summary.github && !view.summary.field && (
              <p className="text-gray-500 text-sm">No committed summaries for this period.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
