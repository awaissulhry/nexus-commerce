import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
try {
  const rows = await p.$queryRawUnsafe(`
    SELECT l.pid, l.granted, l.classid, l.objid, a.state,
           date_trunc('second', now()-a.state_change)::text AS idle_for,
           left(a.query, 50) AS q
    FROM pg_locks l JOIN pg_stat_activity a USING (pid)
    WHERE l.locktype = 'advisory'
    ORDER BY l.granted DESC`)
  for (const r of rows) console.log(`pid=${r.pid} granted=${r.granted} classid=${r.classid} objid=${r.objid} state=${r.state} idle_for=${r.idle_for} q="${r.q}"`)
} catch (e) { console.log('err:', e.message) } finally { await p.$disconnect() }
