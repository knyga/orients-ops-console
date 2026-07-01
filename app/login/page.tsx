/**
 * Login page (outside the dashboard shell). One "Sign in with Slack" button →
 * GET /api/auth/login. Shows a denied message when redirected back with
 * ?denied=1 (e.g. a workspace member who is not on the allowlist).
 */
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; reason?: string }>;
}) {
  const { denied } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">
          Orients Ops Console
        </h1>
        <p className="mt-1 text-sm text-slate-500">Sign in to continue.</p>

        {denied ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Your Slack account isn&apos;t authorized for this console. Ask an admin to
            add you to the allowlist.
          </p>
        ) : null}

        <a
          href="/api/auth/login"
          className="mt-6 flex h-10 w-full items-center justify-center rounded-md bg-slate-900 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign in with Slack
        </a>
      </div>
    </div>
  );
}
