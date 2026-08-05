import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT marketplace, COUNT(DISTINCT asin)::int AS asins, COUNT(DISTINCT "startDate")::int AS weeks,
         COUNT(*)::int AS rows, COUNT(*) FILTER (WHERE "impressionsBrand">0)::int AS measured
  FROM "SearchQueryPerformance" GROUP BY 1 ORDER BY 4 DESC`)
for (const r of rows) console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '))
await p.$disconnect()
