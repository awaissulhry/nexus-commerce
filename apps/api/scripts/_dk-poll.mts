/**
 * Poll the pending Data Kiosk queries and ingest any that have finished.
 *
 * Safe to run repeatedly. An economics query took over 11 minutes to reach DONE
 * in testing, so expect several runs returning running=N before rows land.
 *
 * Usage: cd apps/api && npx tsx scripts/_dk-poll.mts
 */
import { runDataKioskPollCycle } from '../src/services/amazon/data-kiosk.service.js'
import prisma from '../src/db.js'

const out = await runDataKioskPollCycle()
console.log('POLL:', JSON.stringify(out, null, 2))

const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "marketplace", COUNT(*)::int AS rows,
         MIN("date")::text AS first_day, MAX("date")::text AS last_day,
         COUNT(*) FILTER (WHERE "costOfGoodsSold" IS NOT NULL)::int AS with_cogs,
         ROUND(SUM("netProceedsTotal")::numeric, 2) AS net_proceeds
  FROM "AmazonEconomicsDaily" GROUP BY 1 ORDER BY 2 DESC`)
console.log('\nAmazonEconomicsDaily now:')
console.table(rows)

await prisma.$disconnect()
