#!/usr/bin/env node
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL.replace('-pooler', '')
const client = new pg.Client({ connectionString: url })
await client.connect()

// Find any session holding the Prisma migrate advisory lock.
const holders = await client.query(`
  SELECT pl.pid as pid, sa.state as state, now() - sa.query_start as runtime
  FROM pg_locks pl
  JOIN pg_stat_activity sa ON sa.pid = pl.pid
  WHERE pl.locktype = 'advisory' AND pl.objid = 72707369 AND pl.granted = true
`)
console.log(`Found ${holders.rows.length} holder(s) of advisory lock 72707369`)
console.table(holders.rows)

for (const row of holders.rows) {
  if (row.state !== 'idle') {
    console.log(`SKIP pid ${row.pid} — state=${row.state}, not safe to terminate`)
    continue
  }
  const r = await client.query('SELECT pg_terminate_backend($1) as ok', [row.pid])
  console.log(`Terminated pid ${row.pid}: ${r.rows[0].ok}`)
}

await client.end()
