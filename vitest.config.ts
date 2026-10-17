import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // The two-process E2E runs only via `npm run test:e2e` (vitest.e2e.config.ts).
    exclude: [...configDefaults.exclude, "e2e/**"],
    setupFiles: ["./src/test/setupDataDir.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
