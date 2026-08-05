/** Is impressionsTotal per (term,asin) the QUERY-level total duplicated per ASIN row? */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT "searchQuery" AS term, asin, "impressionsTotal", "impressionsBrand"
  FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND "startDate"='2026-07-19' AND "searchQuery"='giacca moto estiva uomo'
  ORDER BY asin`)
for (const r of rows) console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '))
const agg = await p.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*)::int AS asin_rows, SUM("impressionsTotal")::int AS summed, MAX("impressionsTotal")::int AS maxed,
         COUNT(DISTINCT "impressionsTotal")::int AS distinct_totals
  FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND "startDate"='2026-07-19' AND "searchQuery"='giacca moto estiva uomo'`)
console.log('\n', agg[0])
await p.$disconnect()
