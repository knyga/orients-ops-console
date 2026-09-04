"use client";

import { useState } from "react";

interface LinkedMessage { ts: string; user?: string; botId?: string; text: string; threadTs?: string; replyCount?: number }
interface LinkResult {
  url: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  messages: LinkedMessage[];
  rendered: string;
}

/**
 * Slack Link — the web twin of `npm run slack-link` / the agent's `slack_read_link`
 * tool. Paste a Slack message permalink and see exactly what the bot reads from it:
 * the rendered transcript (message or whole thread, «→» = the linked message) plus
 * the raw messages. Live fetch via GET /api/slack-link.
 */
export default function SlackLinkPage() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function resolve(e: React.FormEvent) {
    e.preventDefault();
    const target = url.trim();
    if (!target) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/slack-link?url=${encodeURIComponent(target)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setResult(body as LinkResult);
      setError(null);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Slack Link</h1>
        <p className="text-sm text-slate-500">
          What the bot reads behind a Slack message permalink — the message, or its whole thread with the linked one marked «→».
          CLI: <code>npm run slack-link -- &lt;url&gt;</code>.
        </p>
      </div>
      <form onSubmit={resolve} className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://orientsai.slack.com/archives/C…/p…"
          className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          {loading ? "Reading…" : "Read"}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && (
        <>
          <div className="rounded border border-slate-200 p-4 text-sm">
            <p>
              Channel <code>{result.channelId}</code> · ts <code>{result.ts}</code>
              {result.threadTs && <> · thread root <code>{result.threadTs}</code></>} · {result.messages.length} message(s)
            </p>
          </div>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-600">Rendered (what the agent sees)</h2>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-4 text-sm">{result.rendered}</pre>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-600">Raw messages</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-1 pr-4">ts</th><th className="py-1 pr-4">Author</th><th className="py-1">Text</th>
                </tr>
              </thead>
              <tbody>
                {result.messages.map((m) => (
                  <tr key={m.ts} className={`border-b border-slate-100 ${m.ts === result.ts ? "bg-amber-50" : ""}`}>
                    <td className="py-1 pr-4 font-mono text-xs">{m.ts}</td>
                    <td className="py-1 pr-4 font-mono text-xs">{m.user ?? (m.botId ? `bot ${m.botId}` : "—")}</td>
                    <td className="whitespace-pre-wrap py-1">{m.text || <span className="text-slate-400">(no text)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
