/**
 * Data Kiosk economics — current state. READ-ONLY.
 *
 * The one question that decides whether enabling the cron is worth anything:
 * does Amazon actually return a cost of goods sold, or does it come back null
 * because nobody has entered costs in Seller Central?
 */
import prisma from '../src/db.js'

const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "marketplaceId",
         COUNT(*)::int                                              AS rows,
         MIN("date")::text                                          AS first_day,
         MAX("date")::text                                          AS last_day,
         COUNT(DISTINCT "date")::int                                AS days,
         COUNT(DISTINCT "childAsin")::int                           AS asins,
         COUNT(*) FILTER (WHERE "costOfGoodsSold" IS NOT NULL)::int  AS with_cogs,
         COUNT(*) FILTER (WHERE "netProceedsTotal" IS NOT NULL)::int AS with_net,
         ROUND(SUM("netProductSales")::numeric, 2)                   AS sales,
         ROUND(SUM("netProceedsTotal")::numeric, 2)                  AS net_proceeds
  FROM "AmazonEconomicsDaily"
  GROUP BY 1 ORDER BY 2 DESC`)
console.log('AmazonEconomicsDaily by marketplace:')
console.table(rows)

const jobs = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "status", COUNT(*)::int AS n, MAX("createdAt")::text AS newest
  FROM "DataKioskQueryJob" GROUP BY 1 ORDER BY 2 DESC`)
console.log('\nDataKioskQueryJob:')
console.table(jobs)

const cron = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "jobName", COUNT(*)::int AS runs, MAX("startedAt")::text AS last_run
  FROM "CronRun" WHERE "jobName" LIKE 'data-kiosk%' GROUP BY 1`)
console.log('\nCronRun (data-kiosk*):', cron.length ? '' : 'NEVER RUN')
if (cron.length) console.table(cron)

// Does OUR catalogue hold any cost price? Data Kiosk's COGS is Amazon-side, ours is not.
const ours = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT COUNT(*)::int AS products,
         COUNT(*) FILTER (WHERE "costPrice" IS NOT NULL)::int AS with_cost
  FROM "Product"`)
console.log('\nOur own Product.costPrice:')
console.table(ours)

await prisma.$disconnect()
