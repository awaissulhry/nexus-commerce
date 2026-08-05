/** ACR.2 — what SQP weeks are stored, and how zeroed are they? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('stored weeks per marketplace, and how many rows carry OUR counts')
show(await q(`
  SELECT marketplace, "startDate"::text AS week, COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE "impressionsBrand" > 0)::int AS with_our_impr,
         COUNT(DISTINCT asin)::int AS asins,
         SUM("impressionsTotal")::bigint AS market_impr
  FROM "SearchQueryPerformance"
  GROUP BY 1,2 ORDER BY 2 DESC, 1`), 40)

h('totals')
show(await q(`
  SELECT COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE "impressionsBrand" > 0)::int AS with_our_impr,
         COUNT(DISTINCT marketplace)::int AS markets,
         COUNT(DISTINCT "startDate")::int AS weeks,
         MIN("startDate")::text AS oldest, MAX("startDate")::text AS newest
  FROM "SearchQueryPerformance"`))

h('which ASINs would a re-ingest ask for (top by advertised presence)')
show(await q(`
  SELECT DISTINCT asin, COUNT(*)::int AS rows FROM "SearchQueryPerformance"
  WHERE marketplace = 'IT' GROUP BY 1 ORDER BY 2 DESC`), 15)

await p.$disconnect()
