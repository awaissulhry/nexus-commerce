import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('the null-userId rows — what are they?', await q(`
  SELECT "actionType", "entityType", COUNT(*) AS n,
         MIN("createdAt")::text AS first, MAX("createdAt")::text AS last
  FROM "AdvertisingActionLog" WHERE "userId" IS NULL
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`))
show('do they carry an outboundQueueId (i.e. a real write)?', await q(`
  SELECT ("outboundQueueId" IS NOT NULL) AS has_queue, ("executionId" IS NOT NULL) AS has_changeset,
         COUNT(*) AS n
  FROM "AdvertisingActionLog" WHERE "userId" IS NULL GROUP BY 1,2 ORDER BY 3 DESC`))
show('sample null-attribution rows', await q(`
  SELECT "actionType", "entityType", left("payloadBefore"::text,90) AS before, left("payloadAfter"::text,90) AS after
  FROM "AdvertisingActionLog" WHERE "userId" IS NULL ORDER BY "createdAt" DESC LIMIT 4`))
show('coverage: rows WITH an actor', await q(`
  SELECT CASE WHEN "userId" IS NULL THEN 'unattributed' ELSE 'attributed' END AS bucket, COUNT(*) AS n
  FROM "AdvertisingActionLog" GROUP BY 1`))
await p.$disconnect()
