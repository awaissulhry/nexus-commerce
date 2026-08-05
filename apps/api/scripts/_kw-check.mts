import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const r = await p.$queryRawUnsafe(`SELECT "entityType", COUNT(*) AS n FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
console.log(JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v))
await p.$disconnect()
