import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
console.log(JSON.stringify(await q(`
  SELECT "liveBidWritesEnabled" AS allowlisted, status, COUNT(*) AS n
  FROM "Campaign" GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC`), (_k,v)=>typeof v==='bigint'?Number(v):v, 1))
console.log('\nscheduled campaigns still writable:', JSON.stringify(await q(`
  SELECT COUNT(*) AS n FROM "AdSchedule" s JOIN "Campaign" c ON c.id=s."campaignId"
  WHERE s.enabled AND c."liveBidWritesEnabled"`), (_k,v)=>typeof v==='bigint'?Number(v):v))
await p.$disconnect()
