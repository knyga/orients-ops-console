import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Resolve module aliases for vitest: (1) `server-only` → empty react-server build so
 * server-only lib modules (e.g. lib/computeVerdicts, lib/fieldQaExtract,
 * lib/publishVerdicts, lib/runNightly) can be unit-tested; mirrors `node
 * --conditions=react-server` CLI behavior. (2) `@` → repo root for lib module imports
 * matching the tsconfig.json path so tests can `import { ... } from "@/lib/..."`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
