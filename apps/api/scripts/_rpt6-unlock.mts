import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
// Only IDLE backends holding an advisory lock — an active query is never touched.
const rows = await p.$queryRawUnsafe<Array<{ pid: number; terminated: boolean }>>(
  `SELECT a.pid, pg_terminate_backend(a.pid) AS terminated
   FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory' AND a.state = 'idle' AND a.pid <> pg_backend_pid()`)
console.log('terminated idle lock holders:', rows.map(r => r.pid).join(', ') || 'none')
await p.$disconnect(); process.exit(0)
