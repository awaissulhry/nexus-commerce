import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<any[]>(s)
const n=(v:any)=>typeof v==='bigint'?Number(v):v
const show=(r:any[])=>r.length?r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${n(v)}`).join('  '))):console.log('  (none)')
show(await q(`SELECT now()::text AS now_utc`))
console.log('\n— exact placement writes since 10:05 —')
show(await q(`SELECT "createdAt"::text AS at, "actionType", "amazonResponseStatus", "userId"
  FROM "AdvertisingActionLog" WHERE "createdAt" > timestamp '2026-08-05 10:05'
  ORDER BY "createdAt" LIMIT 10`))
console.log('\n— rank-defend ticks, newest first —')
show(await q(`SELECT "startedAt"::text AS at, "finishedAt"::text AS fin, status, LEFT(COALESCE("outputSummary","errorMessage"),60) AS s
  FROM "CronRun" WHERE "jobName"='ad-rank-defend' ORDER BY "startedAt" DESC LIMIT 4`))
await p.$disconnect(); process.exit(0)
