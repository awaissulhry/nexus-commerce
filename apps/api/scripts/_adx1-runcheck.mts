import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
console.log(JSON.stringify(await q(`
  SELECT "startedAt"::text AS started, status,
         EXTRACT(EPOCH FROM (COALESCE("finishedAt", now()) - "startedAt"))::int AS secs,
         left(COALESCE("outputSummary",'<null>'),150) AS summary
  FROM "CronRun" WHERE "jobName"='advertising-rule-evaluator'
  ORDER BY "startedAt" DESC LIMIT 6`), (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
await p.$disconnect()
