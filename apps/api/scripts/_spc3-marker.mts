import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
const j=(x:unknown)=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?Number(v):v)
console.log('reportRunId on the ams rows — does the AX2.3 marker cover all of them?')
console.log(j(await p.$queryRawUnsafe(`
  SELECT "reportRunId", COUNT(*)::int rows FROM "AmazonAdsDailyPerformance"
  WHERE "profileId"='ams' GROUP BY 1 ORDER BY 2 DESC`)))
console.log('\ndoes the marker appear on any row that is NOT profileId=ams?')
console.log(j(await p.$queryRawUnsafe(`
  SELECT "profileId", "entityType", COUNT(*)::int rows FROM "AmazonAdsDailyPerformance"
  WHERE "reportRunId"='ams-stream' AND "profileId"<>'ams' GROUP BY 1,2`)))
console.log('\nwhich other consumers already exclude it?')
await p.$disconnect()
