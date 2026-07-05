/** F1 — vitest for the pure cores (ledger, registry, csv, vault, guardrails, field-strip). */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/*.test.ts"],
    testTimeout: 10_000,
  },
});
