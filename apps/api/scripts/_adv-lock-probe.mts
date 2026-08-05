import { resolve } from 'path'; import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/apps/api/.env' })
config({ path: '/Users/awais/nexus-commerce/.env' })
const raw = process.env.DATABASE_URL ?? ''
const direct = raw.replace('-pooler', '')
console.log('pooler in URL:', raw.includes('-pooler'), '| DIRECT host:', direct.split('@')[1]?.split('/')[0])
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url: direct } } })
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: unknown[]) => console.log(`\n=== ${t} ===\n` + JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 1))

show('advisory locks held right now', await q(`
  SELECT l.pid, l.granted, l.objid, a.state, a.application_name,
         date_trunc('second', now() - a.state_change)::text AS in_state,
         left(regexp_replace(coalesce(a.query,''), '\\s+', ' ', 'g'), 100) AS query
  FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' ORDER BY l.granted DESC`))

show('holders of the prisma migrate lock 72707369', await q(`
  SELECT COUNT(*) AS holders FROM pg_locks WHERE locktype='advisory' AND objid=72707369 AND granted`))

show('idle-in-transaction / long backends', await q(`
  SELECT pid, state, application_name,
         date_trunc('second', now() - state_change)::text AS in_state,
         left(regexp_replace(coalesce(query,''), '\\s+',' ','g'), 90) AS query
  FROM pg_stat_activity
  WHERE datname='neondb' AND pid <> pg_backend_pid()
    AND (state='idle in transaction' OR now() - state_change > interval '2 minutes')
  ORDER BY state_change LIMIT 15`))

show('migrations stuck unapplied', await q(`
  SELECT migration_name, started_at::text, finished_at::text, applied_steps_count
  FROM _prisma_migrations WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 10`))

show('most recent migrations', await q(`
  SELECT migration_name, finished_at::text FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5`))
await p.$disconnect()
