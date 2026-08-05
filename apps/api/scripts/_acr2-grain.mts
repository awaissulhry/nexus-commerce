import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const r = await p.$queryRawUnsafe<any[]>(`
  SELECT "entityType", COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last
  FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY rows DESC`)
r.forEach(x => console.log(' ', Object.entries(x).map(([k,v])=>`${k}=${v}`).join('  ')))
await p.$disconnect(); process.exit(0)
