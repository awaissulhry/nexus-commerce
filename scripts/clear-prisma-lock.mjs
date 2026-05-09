#!/usr/bin/env node
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = (process.env.DATABASE_URL || '').replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const client = new pg.Client({ connectionString: url })
await client.connect()
const r = await client.query(`
  SELECT pid, mode, locktype, granted
  FROM pg_locks
  WHERE locktype='advisory' AND objid=72707369
`)
console.log('Advisory locks on 72707369:', r.rows)
for (const row of r.rows) {
  if (row.pid) {
    const r2 = await client.query(`SELECT pg_terminate_backend($1) AS ok`, [row.pid])
    console.log(`Terminated pid ${row.pid}:`, r2.rows[0])
  }
}
await client.end()
