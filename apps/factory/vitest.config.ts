/** F1 — vitest for the pure cores (ledger, registry, csv, vault, guardrails, field-strip). */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    // The design-system copy carries its own *.vitest.test.ts files (mirrored from apps/web); they ran nowhere until 2026-09-26.
    include: ["src/**/__tests__/*.test.ts", "src/**/*.vitest.test.ts"],
    testTimeout: 10_000,
  },
});
