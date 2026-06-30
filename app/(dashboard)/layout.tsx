import Link from "next/link";

/**
 * Dashboard tab shell. The field-team module ships the video feature today;
 * other modules (dev reporting) slot in as tabs later, so the nav is data-driven
 * with an `enabled` flag rather than hard-coded.
 */
const TABS: { href: string; label: string; enabled: boolean }[] = [
  { href: "/field-ops", label: "Field Ops", enabled: true },
  { href: "/field-qa", label: "Field QA", enabled: true },
  { href: "/field-verdict", label: "Field Verdict", enabled: true },
  { href: "/field-bonus", label: "Field Bonus", enabled: true },
  { href: "/dev-reporting", label: "Dev Reporting", enabled: true },
  { href: "/github-reporting", label: "GitHub Activity", enabled: true },
  { href: "/people", label: "People", enabled: true },
  { href: "/policy-tracking", label: "Policy Tracking", enabled: true },
  { href: "/drive", label: "Drive Sync", enabled: true },
  { href: "/sent", label: "Outbound", enabled: true },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto w-full max-w-7xl px-6">
          <div className="flex h-14 items-center gap-3">
            <span className="text-sm font-semibold tracking-tight text-slate-900">
              Orients Ops Console
            </span>
            <nav className="ml-6 flex items-center gap-1">
              {TABS.map((tab) =>
                tab.enabled ? (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                  >
                    {tab.label}
                  </Link>
                ) : (
                  <span
                    key={tab.href}
                    aria-disabled="true"
                    title="Coming soon"
                    className="cursor-not-allowed rounded-md px-3 py-1.5 text-sm font-medium text-slate-400"
                  >
                    {tab.label}
                  </span>
                ),
              )}
            </nav>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">
        {children}
      </main>
    </div>
  );
}
