import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Resolve the `server-only` guard to its empty react-server build so server-only
 * lib modules (e.g. lib/computeVerdicts, lib/fieldQaExtract, lib/publishVerdicts,
 * lib/runNightly) can be unit-tested under vitest. This mirrors how the CLIs run
 * them — `node --conditions=react-server` picks the same `empty.js`; the default
 * export throws by design to catch accidental client imports. Scoped to this one
 * specifier so no other module resolution changes.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
});
