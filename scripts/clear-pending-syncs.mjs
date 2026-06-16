#!/usr/bin/env node
// One-shot (operator-requested 2026-06-16): clear the stale outbound-sync backlog
// so no queued cascade changes fire when the worker is fixed. Deletes the ACTIVE
// queue (PENDING + the stuck IN_PROGRESS row). Terminal rows (SUCCESS/FAILED/
// CANCELLED/SKIPPED) are left untouched. Master data is authoritative — the next
// real change re-pushes current values, so nothing is permanently lost.
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()
try {
  const before = await c.query(
    `SELECT "syncStatus", "targetChannel", count(*)::int AS n
     FROM "OutboundSyncQueue"
     WHERE "syncStatus" IN ('PENDING','IN_PROGRESS')
     GROUP BY 1,2 ORDER BY 1,2`,
  )
  console.log('Active queue to delete (by status × channel):')
  console.table(before.rows)
  const total = before.rows.reduce((s, r) => s + r.n, 0)
  console.log(`Total to delete: ${total}`)

  const del = await c.query(
    `DELETE FROM "OutboundSyncQueue" WHERE "syncStatus" IN ('PENDING','IN_PROGRESS')`,
  )
  console.log(`Deleted: ${del.rowCount} rows.`)

  const after = await c.query(
    `SELECT count(*)::int AS remaining_active
     FROM "OutboundSyncQueue" WHERE "syncStatus" IN ('PENDING','IN_PROGRESS')`,
  )
  console.log('Remaining active queue:', after.rows[0].remaining_active)
} catch (e) {
  console.error('FAILED:', e.message)
  process.exit(1)
}
await c.end()
