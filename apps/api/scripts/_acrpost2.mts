import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s:string)=>p.$queryRawUnsafe<any[]>(s)
const n=(v:any)=>typeof v==='bigint'?Number(v):v
const show=(r:any[])=>r.length?r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${n(v)}`).join('  '))):console.log('  (none)')
show(await q(`SELECT now()::text AS db_now_utc`))
console.log('\n— ANY cron activity in the last 40 minutes (is the fleet alive?) —')
show(await q(`SELECT "jobName", COUNT(*)::int AS runs, MAX("startedAt")::text AS last
  FROM "CronRun" WHERE "startedAt" > now() - interval '40 minutes'
  GROUP BY "jobName" ORDER BY last DESC LIMIT 12`))
console.log('\n— rank-defend, last 8 runs whenever they were —')
show(await q(`SELECT "startedAt"::text AS at, status, LEFT("outputSummary",60) AS summary
  FROM "CronRun" WHERE "jobName"='ad-rank-defend' ORDER BY "startedAt" DESC LIMIT 8`))
await p.$disconnect(); process.exit(0)
