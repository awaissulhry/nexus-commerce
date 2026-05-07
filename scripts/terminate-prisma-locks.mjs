import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join('/Users/awais/nexus-commerce', '.env') })

const url = (process.env.DATABASE_URL || '').replace('-pooler.c-', '.c-')
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const client = new pg.Client({ connectionString: url })
await client.connect()

// Find prisma sessions holding advisory locks (lock id 72707369 per the error)
const sessions = await client.query(`
  SELECT pid, application_name, state, query_start, state_change
  FROM pg_stat_activity
  WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory')
  ORDER BY state_change DESC
`)
console.log('Sessions with advisory locks:', sessions.rows.length)
console.table(sessions.rows)

// Terminate any backend holding an advisory lock that's idle.
// The advisory lock id Prisma uses for migrate is 72707369; previously
// crashed migrate runs leave their pgbouncer-fronted backend stuck
// idle on the lock. Safe in single-tenant ops.
for (const r of sessions.rows) {
  if (r.state === 'idle' || r.state === 'idle in transaction') {
    const out = await client.query('SELECT pg_terminate_backend($1) as terminated', [r.pid])
    console.log(`Terminated pid ${r.pid} (${r.application_name}, ${r.state}):`, out.rows[0].terminated)
  }
}

await client.end()
