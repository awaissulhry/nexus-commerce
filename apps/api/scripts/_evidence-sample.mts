import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('columns', await q(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='AdvertisingActionLog' ORDER BY ordinal_position`))
show('sample rows WITH evidence', await q(`
  SELECT "createdAt"::text, evidence::text
  FROM "AdvertisingActionLog" WHERE evidence IS NOT NULL
  ORDER BY "createdAt" DESC LIMIT 3`))
await p.$disconnect()
