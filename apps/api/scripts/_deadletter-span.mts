import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT date_trunc('day',"updatedAt")::date::text AS day, count(*)::int AS failures,
         count(DISTINCT "entityId")::int AS targets, max("attempts")::int AS max_attempts
  FROM "AdMutation" WHERE state='FAILED' AND "entityType"='AD_TARGET'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 10`)
console.log('failed AD_TARGET writes by day:'); console.table(rows)
const dist = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "attempts"::int AS attempts, count(*)::int AS n FROM "AdMutation"
  WHERE state='FAILED' AND "entityType"='AD_TARGET' GROUP BY 1 ORDER BY 1`)
console.log('attempts distribution:'); console.table(dist)
const first = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT min("createdAt")::text AS first_seen, max("createdAt")::text AS last_seen, count(*)::int AS total
  FROM "AdMutation" WHERE state='FAILED' AND "entityType"='AD_TARGET'`)
console.log('span:', JSON.stringify(first[0]))
await p.$disconnect()
