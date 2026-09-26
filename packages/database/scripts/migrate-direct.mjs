#!/usr/bin/env node
/**
 * Run `prisma migrate deploy` against the DIRECT (non-pooler) Neon endpoint.
 *
 * WHY
 * ---
 * `migrate deploy` takes a SESSION-scoped advisory lock (pg_advisory_lock(72707369)).
 * Through the Neon POOLER, pgbouncer hands it a pooled server connection. If the migrate
 * process then exits without releasing — a crash, an OOM, a container kill mid-deploy —
 * the lock survives, because it belongs to the server session that pgbouncer keeps alive
 * and recycles for ordinary traffic. Nothing releases it.
 *
 * Every subsequent boot then waits 10s for that lock, times out with P1002, and crashes.
 * Railway restarts, and it happens again: a self-sustaining outage that only ends when
 * pgbouncer happens to recycle the holding connection. That is exactly what took the API
 * down on 2026-08-04 (~14:18, roughly 20 minutes).
 *
 * On a DIRECT connection there is no pooler in between, so the session ends when this
 * process ends and Postgres releases the lock automatically.
 *
 * Production requires MIGRATION_DATABASE_URL, an administrative credential separate
 * from the restricted runtime DATABASE_URL. Development may use DATABASE_URL.
 * This is a release command, never an application startup command.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { checkAppliedButMissing, reportAndExitCode } from './check-applied-but-missing.mjs'
import { migrationConnection } from './migration-connection.mjs'

let direct
try { direct = migrationConnection() } catch (error) {
  console.error('[migrate]', error.message)
  process.exit(1)
}
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
console.log('[migrate] checking history before applying migrations on the direct endpoint')

// ── Applied-but-missing gate (PLAN Step 0.1 / amendment A-2) ──────
//
// Refuse BEFORE applying anything if this database records a migration that has no folder in
// prisma/migrations/. Nothing else in the pipeline looks in that direction: check-schema-drift
// reads only repo files, check-migrations-state computes only the opposite set, and
// `migrate deploy` applies pending migrations without noticing extra ones.
//
// It runs here rather than in .githooks/pre-push because the check has to query the target
// database, and a push hook would need a production credential on every developer's machine —
// which is the variable PLAN Step 0.3 exists to remove. Here it is already present.
//
// `DATABASE_URL` is deliberately the DIRECT url, matching the migration that follows it.
const gate = await checkAppliedButMissing({ connectionString: direct })
const gateExit = reportAndExitCode(gate)
if (gateExit !== 0) {
  console.error('[migrate] refusing to deploy — see the applied-but-missing report above')
  process.exit(gateExit)
}

const require = createRequire(import.meta.url)
const res = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  stdio: 'inherit',
  timeout: 300_000,
  env: { ...process.env, DATABASE_URL: direct, MIGRATION_DATABASE_URL: direct },
})

if (res.error) {
  console.error('[migrate] failed to spawn prisma:', res.error.message)
  process.exit(1)
}
process.exit(res.status ?? 1)
