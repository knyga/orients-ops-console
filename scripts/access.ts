/**
 * CLI: the second interface for the console auth gate. Same code path as the web
 * (lib/auth.ts / lib/allowedUsers.ts).
 *
 * Usage:
 *   npm run access -- list [--format table]
 *   npm run access -- verify <cookie-value>
 *
 * Runs under `--conditions=react-server` so any server-only import resolves.
 */
import { ALLOWED_USERS } from "../lib/allowedUsers";
import { verifySession } from "../lib/auth";
import { authSecret } from "../lib/authCookies";

function formatTable(): string {
  const lines = ["userId         name", "-------------- --------------------"];
  for (const u of ALLOWED_USERS) lines.push(`${u.userId.padEnd(14)} ${u.name}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on ambient env */
  }

  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "list") {
    if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "table") {
      console.log(formatTable());
    } else {
      console.log(JSON.stringify({ count: ALLOWED_USERS.length, users: ALLOWED_USERS }, null, 2));
    }
    return;
  }

  if (cmd === "verify") {
    const token = argv[1];
    if (!token) throw new Error("usage: npm run access -- verify <cookie-value>");
    const res = await verifySession(token, authSecret());
    console.log(
      JSON.stringify(
        {
          valid: res.valid,
          expired: res.expired,
          userId: res.payload?.userId ?? null,
          name: res.payload?.name ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error("usage: npm run access -- <list|verify> [...]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`access: ${message}\n`);
  process.exit(1);
});
