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
