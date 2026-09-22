#!/usr/bin/env node
/**
 * PLAN Step 0.4 — replay every migration from zero and record EVERY failure, not only the first.
 *
 * WHY THIS EXISTS. `prisma migrate deploy` stops at the first failure, so it can tell you that the
 * history does not replay but never how badly. Measured 2026-09-22: a fresh database reaches
 * migration 19 of 467 and dies on `20260502_phase_d3_cascade_categoryattrs_gtin` with
 * `42P01 relation "BulkOperation" does not exist`. Attribution was established before reporting —
 * the same failure occurs with the applied-but-missing gate bypassed entirely, so it is
 * pre-existing. Production is unaffected because it is already migrated and applies zero.
 *
 * It blocks Part 15.11's scale fixture ("a seeded workspace at 1,000 and 10,000 products"), which
 * 15.13 ranks #2 — and a real shadow database, a clean CI database and a rebuild with it.
 *
 * WHAT IT DOES. Applies each migration's SQL itself, in folder order, in its own transaction, and
 * CONTINUES past a failure so the full list comes out in one run. It never writes
 * `_prisma_migrations`: this is a diagnostic, not a migration tool.
 *
 * 🔴 SAFETY. It refuses any target that is not a local, disposable database — the host must be
 * loopback AND the database name must carry the disposable prefix. It is never pointed at
 * production, and the refusal states the host it saw rather than failing quietly.
 *
 *   node packages/database/scripts/replay-migrations.mjs            # create, replay, drop
 *   node packages/database/scripts/replay-migrations.mjs --keep     # leave the database behind
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'prisma', 'migrations')
const DISPOSABLE_PREFIX = 'nexus_replay_'
const KEEP = process.argv.includes('--keep')

function adminUrlFromLocalEnv() {
  // apps/api/.env is the local Docker database this repo's own test guard pins to.
  const text = readFileSync(join(here, '..', '..', 'apps', 'api', '.env'), 'utf8')
  const found = text.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)
  if (!found) throw new Error('apps/api/.env has no DATABASE_URL')
  return found[1]
}

function assertLocal(url) {
  const parsed = new URL(url)
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
  if (!local) {
    throw new Error(`REFUSED: replay target is not local — host "${parsed.hostname}". This script creates and drops databases.`)
  }
  return parsed
}

const folders = readdirSync(migrationsDir)
  .filter((entry) => {
    try { return statSync(join(migrationsDir, entry)).isDirectory() } catch { return false }
  })
  .sort()

const base = adminUrlFromLocalEnv()
const parsed = assertLocal(base)
const dbName = `${DISPOSABLE_PREFIX}${Date.now()}`
const adminUrl = `${base.slice(0, base.lastIndexOf('/'))}/postgres`
const targetUrl = `${base.slice(0, base.lastIndexOf('/'))}/${dbName}`

console.log(`[replay] host ${parsed.hostname}:${parsed.port}  database ${dbName}  migrations ${folders.length}`)

const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`)
await admin.query(`CREATE DATABASE "${dbName}"`)
await admin.end()

const client = new pg.Client({ connectionString: targetUrl })
await client.connect()

const failures = []
let applied = 0
for (const [index, folder] of folders.entries()) {
  let sql
  try {
    sql = readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8')
  } catch {
    failures.push({ index: index + 1, folder, code: 'NO_SQL', message: 'no migration.sql in the folder' })
    continue
  }
  try {
    // Each migration in its own transaction so one failure cannot poison the next.
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
    applied++
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    failures.push({ index: index + 1, folder, code: err.code ?? '?', message: String(err.message).split('\n')[0] })
  }
}

await client.end()

if (!KEEP) {
  const cleanup = new pg.Client({ connectionString: adminUrl })
  await cleanup.connect()
  await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}"`)
  await cleanup.end()
  console.log(`[replay] dropped ${dbName}`)
} else {
  console.log(`[replay] kept ${dbName} — drop it yourself when done`)
}

console.log(`\n[replay] applied ${applied} of ${folders.length}; ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nFAILURES, in order:\n')
  for (const f of failures) console.log(`  #${String(f.index).padStart(3)}  ${f.folder}\n        ${f.code}  ${f.message}`)
  // Grouped, because one missing table usually explains a run of them.
  const byCode = failures.reduce((acc, f) => ({ ...acc, [f.code]: (acc[f.code] ?? 0) + 1 }), {})
  console.log('\nBy error code:', byCode)
}
process.exit(failures.length > 0 ? 1 : 0)
