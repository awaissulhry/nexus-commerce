import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const r = await p.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT "entityType", COUNT(*)::int rows, MIN(date)::date first, MAX(date)::date last
  FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
for (const x of r) console.log('  ', Object.entries(x).map(([k,v])=>`${k}=${v instanceof Date ? v.toISOString().slice(0,10) : v}`).join(' '))
await p.$disconnect(); process.exit(0)
