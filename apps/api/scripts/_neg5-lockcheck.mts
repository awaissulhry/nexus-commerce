/** NEG.5 — is the prod migration advisory lock stuck? READ-ONLY.
 *  The API crashed with P1002 on `SELECT pg_advisory_lock(72707369)` after two sessions'
 *  deploys ran `migrate deploy` ~2 minutes apart. This says whether the lock is still held. */
import '../src/env.js'
import pg from 'pg'
const url = (process.env.DATABASE_URL || '').replace('-pooler', '')
const c = new pg.Client({ connectionString: url })
await c.connect()
const l = await c.query("select pid, mode, granted, objid from pg_locks where locktype='advisory'")
console.log('advisory locks held:', l.rows.length, JSON.stringify(l.rows))
const m = await c.query('select migration_name, finished_at from _prisma_migrations order by started_at desc limit 4')
for (const r of m.rows) console.log(' ', r.migration_name, r.finished_at ? 'applied' : '🔴 UNFINISHED')
await c.end()
