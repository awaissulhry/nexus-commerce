import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const locks = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT l.pid, l.granted, a.state, a.query_start, LEFT(a.query, 60) AS q
   FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory'`)
console.log('advisory locks held:', locks.length)
for (const l of locks) console.log(' ', JSON.stringify(l))
await p.$disconnect(); process.exit(0)
