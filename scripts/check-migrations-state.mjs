#!/usr/bin/env node
// One-shot diagnostic: list the most-recent migrations Neon has applied vs
// what's in the migrations directory. Helps spot "X migrations local, Y on
// Neon — Railway boot would fail trying to query missing columns."
//
// Run: node scripts/check-migrations-state.mjs

import dotenv from 'dotenv'
import path from 'path'
import { readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL missing — set it in .env')
  process.exit(1)
}

const c = new pg.Client({ connectionString: url })
await c.connect()

const r = await c.query(`
  SELECT migration_name, applied_steps_count, finished_at, rolled_back_at, started_at
  FROM "_prisma_migrations"
  ORDER BY started_at DESC
`)
const earliest = await c.query(`
  SELECT migration_name, started_at
  FROM "_prisma_migrations"
  ORDER BY started_at ASC
  LIMIT 5
`)
console.log('Earliest migrations Neon recorded as applied:')
for (const row of earliest.rows) console.log(`  ${row.migration_name}  (${row.started_at.toISOString()})`)
console.log('')

const applied = new Set(r.rows.map((row) => row.migration_name))
const inProgress = r.rows.filter((row) => !row.finished_at && !row.rolled_back_at).map((row) => row.migration_name)
const rolledBack = r.rows.filter((row) => row.rolled_back_at).map((row) => row.migration_name)

const localDir = path.join(here, '..', 'packages', 'database', 'prisma', 'migrations')
const localMigrations = readdirSync(localDir)
  .filter((entry) => {
    try {
      return statSync(path.join(localDir, entry)).isDirectory()
    } catch {
      return false
    }
  })
  .sort()

const pending = localMigrations.filter((m) => !applied.has(m))

console.log(`Total local migrations: ${localMigrations.length}`)
console.log(`Most-recent applied on Neon (top 10):`)
for (const row of r.rows.slice(0, 10)) {
  const status = row.rolled_back_at ? 'ROLLED BACK' : row.finished_at ? 'OK' : 'IN-PROGRESS'
  console.log(`  ${row.migration_name}  [${status}]`)
}

if (pending.length > 0) {
  console.log(`\n⚠ Pending — local has these but Neon hasn't applied them:`)
  for (const m of pending) console.log(`  ${m}`)
}
if (inProgress.length > 0) {
  console.log(`\n⚠ IN-PROGRESS — Neon recorded a started migration that never finished:`)
  for (const m of inProgress) console.log(`  ${m}`)
}
if (rolledBack.length > 0) {
  console.log(`\n⚠ ROLLED BACK — Neon attempted these but rolled back:`)
  for (const m of rolledBack) console.log(`  ${m}`)
}

if (pending.length === 0 && inProgress.length === 0 && rolledBack.length === 0) {
  console.log('\n✓ Local migration tree matches Neon state.')
}

await c.end()
