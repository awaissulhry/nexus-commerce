// P1 #42 — Vitest config for the apps/api workspace.
//
// The existing custom-runner test files (`*.test.ts` files that
// build their own `tests.push(...)` array and run via `npx tsx
// <file>`) are NOT picked up by this config. New tests should use
// vitest's describe / it / expect API and live alongside the
// source they cover (e.g. `src/services/foo.service.test.ts`).
//
// Migrating the legacy tests over is a follow-up sweep — each one
// is small enough to translate in <30 lines. For now, both styles
// coexist:
//   • `npm run test` (this config)        — vitest-shaped tests
//   • `npx tsx <path>/<name>.test.ts`     — legacy custom runners

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The legacy tests use `tests.push(...)` + a manual loop and
    // would not produce useful output via vitest. We exclude them
    // explicitly until the migration sweep lands. New vitest tests
    // can opt in by living under `__tests__/` directories or by
    // using a `.vitest.test.ts` suffix.
    // Legacy custom-runner tests live at `src/**/*.test.ts` and run
    // via `npx tsx`. Vitest picks up only files explicitly opted in
    // by the patterns below — either an `__tests__/` directory or a
    // `.vitest.test.ts` suffix elsewhere.
    include: ['src/**/__tests__/*.test.ts', 'src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    // Per-test timeout: 10s default. DB-touching tests should bump
    // explicitly via `it.concurrent('...', { timeout: 30_000 }, ...)`.
    testTimeout: 10_000,
  },
})
