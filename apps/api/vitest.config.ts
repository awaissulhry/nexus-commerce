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
import { applyTestDatabaseGuard } from './src/lib/testing/database-target.js'

/**
 * 🔴 R-VT-12 (VT.F2, 2026-09-13) — refuse a PRODUCTION database before the first connection.
 *
 * `src/env.ts` loads dotenv non-overriding, so the CWD decides which `.env` wins: from `apps/api` that is the
 * local Docker URL, from the REPO ROOT it is the root `.env` — Neon production. Every lane in the VT programme
 * ran `npx vitest run --root apps/api …` from the repo root, so every DB-backed arm was pointed at prod while
 * its author believed it measured local Docker (measured both ways, no connection made).
 *
 * The guard runs HERE (once, in the main process, so a wrong command fails fast with the host named) and again
 * in `vitest.setup.ts` (per worker, where the pin has to land before any module imports `db.ts`). Both call the
 * SAME function — two "equivalent" rules one file apart is the defect this ruling exists to remove.
 *
 * Deliberate escape hatch: `ALLOW_PROD_DB_TESTS=1`, which prints the host it let past.
 */
const databaseTarget = applyTestDatabaseGuard()
// eslint-disable-next-line no-console
console.log(`[apps/api vitest config] ${databaseTarget.message}`)

export default defineConfig({
  test: {
    // R-VT-12 — the guard, per worker, before the first test module is imported.
    setupFiles: ['./vitest.setup.ts'],
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
