/** SPC.3 — true backfill progress, excluding rows no report can ever fill. READ-ONLY. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ log: [] })
console.log('IT, per backfill window — "real" excludes the AMS-stream leftovers:')
console.table(await p.$queryRawUnsafe(`
  SELECT CASE
           WHEN "date" <  DATE '2026-05-18' THEN '0 · before retention (unreachable)'
           WHEN "date" <= DATE '2026-06-18' THEN 'W1 05-18 → 06-18'
           WHEN "date" <= DATE '2026-07-20' THEN 'W2 06-19 → 07-20'
           ELSE                                  'W3 07-21 → 08-19' END AS window,
         COUNT(*)::int total_rows,
         COUNT(*) FILTER (WHERE "reportRunId"='ams-stream')::int ams_excluded,
         COUNT(*) FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream')::int real_rows,
         COUNT(*) FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream' AND "entityName" IS NOT NULL)::int filled,
         COUNT(*) FILTER (WHERE "reportRunId" IS DISTINCT FROM 'ams-stream' AND "entityName" IS NULL)::int still_unfilled
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "marketplace"='IT'
  GROUP BY 1 ORDER BY 1`))
console.log('\nall markets, new-column coverage (real rows only):')
console.table(await p.$queryRawUnsafe(`
  SELECT "marketplace", COUNT(*)::int rows,
         COUNT("entityName")::int named, COUNT("salesSameSku7dCents")::int samesku,
         COUNT("topOfSearchIS")::int tos, COUNT("campaignBudgetCents")::int budget
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS'
    AND "reportRunId" IS DISTINCT FROM 'ams-stream'
  GROUP BY 1 ORDER BY 2 DESC`))
await p.$disconnect()
