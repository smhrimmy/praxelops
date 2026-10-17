import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Two-OS-process end-to-end suite (`npm run test:e2e`).
 *
 * Deliberately has NO setupFiles: the E2E creates and owns its own temp PRAXELOPS_DATA_DIR and
 * passes it explicitly to the spawned `next start` and terminal gateway processes.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    // beforeAll may have to run `next build` once when .next/BUILD_ID is missing.
    hookTimeout: 900_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
