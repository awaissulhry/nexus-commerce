const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  WITH a AS (
    SELECT "localEntityId" AS cid,
           SUM("costMicros")/1e6 AS spend,
           SUM("sales7dCents")/100.0 AS sales_now,
           SUM("sales7dCents" + COALESCE("sales14dCents",0))/100.0 AS sales_before
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL AND "date" >= CURRENT_DATE - 30
    GROUP BY 1)
  SELECT COUNT(*) FILTER (WHERE sales_before > 0 AND spend/sales_before > 1)::bigint AS b,
         COUNT(*) FILTER (WHERE sales_now    > 0 AND spend/sales_now    > 1)::bigint AS a2
  FROM a`)
console.log(`RESULT over-100%-ACoS  BEFORE my fix = ${Number(r[0].b as bigint)}   AFTER = ${Number(r[0].a2 as bigint)}`)
await prisma.$disconnect()
