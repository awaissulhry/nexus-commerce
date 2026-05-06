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

const r = await client.query(`
  SELECT pid, locktype, mode, granted, classid, objid,
    (SELECT usename FROM pg_stat_activity WHERE pid = pg_locks.pid) as username,
    (SELECT state FROM pg_stat_activity WHERE pid = pg_locks.pid) as state,
    (SELECT now() - query_start FROM pg_stat_activity WHERE pid = pg_locks.pid) as runtime,
    (SELECT substring(query, 1, 80) FROM pg_stat_activity WHERE pid = pg_locks.pid) as query
  FROM pg_locks
  WHERE locktype = 'advisory'
`)
console.log('Advisory locks:')
console.table(r.rows)

const r2 = await client.query(`
  SELECT pid, usename, state, now() - query_start as runtime, substring(query, 1, 80) as query
  FROM pg_stat_activity
  WHERE state IS NOT NULL AND query ILIKE '%advisory%'
`)
console.log('Sessions running advisory_lock:')
console.table(r2.rows)
await client.end()
