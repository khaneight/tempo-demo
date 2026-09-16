import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Suites share one Postgres; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
