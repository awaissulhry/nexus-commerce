// PES.0 hub — READ-ONLY probe: does scheduled-image-publish actually fire on prod?
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT status,
         count(*)::int AS n,
         min("scheduledFor") AS first_due,
         max("scheduledFor") AS last_due,
         max("firedAt") AS last_fired,
         count(*) FILTER (WHERE status = 'PENDING' AND "scheduledFor" < now())::int AS overdue_pending
  FROM "ScheduledImagePublish"
  GROUP BY status ORDER BY status`)
console.log(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2))
await prisma.$disconnect()
