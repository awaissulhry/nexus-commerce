import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  "SELECT l.pid, a.state, a.query_start::text AS started, left(a.query, 70) AS q FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory'",
)
console.log('HOLDERS:', JSON.stringify(rows))
if (process.argv[2] === 'kill') {
  for (const r of rows) {
    const out = await p.$queryRawUnsafe(`SELECT pg_terminate_backend(${Number(r.pid)})`)
    console.log('TERMINATED', r.pid, JSON.stringify(out))
  }
}
await p.$disconnect()
