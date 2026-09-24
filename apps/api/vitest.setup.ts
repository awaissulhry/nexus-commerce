/**
 * R-VT-12 — every `apps/api` vitest worker runs this BEFORE it imports a test file, so the database guard
 * decides the target before any module can open a connection (`db.ts` → `env.ts` → the pg pool captures
 * `DATABASE_URL` at import time).
 *
 * The rule itself lives in `src/lib/testing/database-target.ts` and is unit-tested there. This file is the hook,
 * and it PRINTS the outcome: a guard whose decision is invisible is a guard nobody can check.
 */
import { applyTestDatabaseGuard } from './src/lib/testing/database-target.js'

const outcome = applyTestDatabaseGuard()
// eslint-disable-next-line no-console
console.log(`[apps/api vitest] ${outcome.message}`)

/*
 * 2026-09-16 — the suite STATES its business-profiles mode instead of inheriting it from `.env`.
 *
 * Same defect shape as R-VT-12 above, for a different variable. `src/env.ts` loads `.env` non-overriding when
 * the first module imports it, so the value of `NEXUS_WORKSPACES_ENABLED` a test saw was whatever the CWD's
 * `.env` happened to hold. Turning business profiles on for the local API (`apps/api/.env`) therefore silently
 * switched EVERY local test run — for every session sharing the repo — into profiles-on mode, and 43 files /
 * 272 tests that were never written for it failed. CI never sets the flag, so CI never saw it.
 *
 * At setup time no `.env` has been loaded (see database-target.ts), so `process.env` holds only what the shell
 * exported. An explicit `NEXUS_WORKSPACES_ENABLED=1 npx vitest …` is kept — running the suite with profiles on
 * stays a deliberate, one-word choice. Otherwise the suite runs with profiles OFF, which is what every test in
 * it assumed until today. Because dotenv never overrides, `.env` can no longer change this.
 *
 * Tests that exercise profiles-on behaviour set the flag themselves and restore it (every BP.* suite does).
 */
if (process.env.NEXUS_WORKSPACES_ENABLED === undefined) {
  process.env.NEXUS_WORKSPACES_ENABLED = '0'
  // eslint-disable-next-line no-console
  console.log('[apps/api vitest] business profiles: OFF (default; export NEXUS_WORKSPACES_ENABLED=1 to run with them on)')
} else {
  // eslint-disable-next-line no-console
  console.log(`[apps/api vitest] business profiles: ${process.env.NEXUS_WORKSPACES_ENABLED === '1' ? 'ON' : 'OFF'} (from the shell)`)
}

/*
 * 2026-09-24 — a connected Shopify store's field list is stored as a cache row (`channel-specs/shopify.ts`). Unit tests
 * mock the store, so the suite keeps that row in memory: no test writes a cache row into the shared local database,
 * and no row left by an earlier run decides whether a later run finds a store "cached".
 */
process.env.NEXUS_SHOPIFY_STORE_SCHEMA_ROWS ??= 'memory'
