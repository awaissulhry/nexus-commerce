import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const eur = (v: unknown) => '€' + Number(v).toLocaleString('en-GB',{minimumFractionDigits:2})

console.log('Why naive "zero-sale spend" is wrong, and what an honest figure looks like.\n')
console.log('Attribution is a 7-day window, so clicks in the last 7 days have not had time to convert.')
console.log('And one click with no sale is sampling, not waste — waste means SUSTAINED spend with no return.\n')

for (const [label, matureDays, minClicks] of [
  ['naive: any zero-sale click, whole window', 0, 1],
  ['exclude the unmatured last 7 days', 7, 1],
  ['+ require >= 5 clicks on the term', 7, 5],
  ['+ require >= 10 clicks on the term', 7, 10],
] as Array<[string, number, number]>) {
  const rows = await q(`
    WITH term AS (
      SELECT "query", marketplace,
             SUM(clicks)::int clicks,
             SUM("costMicros")/1000000.0 AS cost,
             SUM(COALESCE("sales7dCents",0)) AS sales_cents
      FROM "AmazonAdsSearchTerm"
      WHERE date >= CURRENT_DATE - 90 AND date <= CURRENT_DATE - ${matureDays}
      GROUP BY 1,2
    )
    SELECT ROUND(SUM(cost) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks})::numeric,2) wasted,
           COUNT(*) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks})::int terms,
           ROUND(SUM(cost)::numeric,2) total,
           ROUND((100.0 * SUM(cost) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks}) / NULLIF(SUM(cost),0))::numeric,1) pct
    FROM term`)
  const r = rows[0]
  console.log(`  ${label.padEnd(42)} ${eur(r.wasted).padStart(11)}  ${String(r.terms).padStart(5)} terms  = ${r.pct}% of ${eur(r.total)}`)
}

console.log('\nTACoS inputs (last 30 days, Amazon):')
const t = await q(`
  SELECT ROUND((SELECT SUM("costMicros")/1000000.0 FROM "AmazonAdsDailyPerformance"
                WHERE "entityType"='CAMPAIGN' AND date >= CURRENT_DATE-30)::numeric,2) ad_spend,
         ROUND((SELECT SUM(COALESCE("sales7dCents",0))/100.0 FROM "AmazonAdsDailyPerformance"
                WHERE "entityType"='CAMPAIGN' AND date >= CURRENT_DATE-30)::numeric,2) ad_sales,
         ROUND((SELECT SUM("grossRevenue") FROM "DailySalesAggregate"
                WHERE channel='AMAZON' AND day >= CURRENT_DATE-30)::numeric,2) total_sales`)
const r = t[0] as Record<string, number>
console.log(`  ad spend ${eur(r.ad_spend)} · ad-attributed sales ${eur(r.ad_sales)} · TOTAL sales ${eur(r.total_sales)}`)
console.log(`  ACOS  = ${(100*r.ad_spend/r.ad_sales).toFixed(2)}%   (spend / ad sales)`)
console.log(`  TACoS = ${(100*r.ad_spend/r.total_sales).toFixed(2)}%   (spend / TOTAL sales)`)
console.log(`  ad-driven share of revenue = ${(100*r.ad_sales/r.total_sales).toFixed(1)}%  · organic ${(100*(1-r.ad_sales/r.total_sales)).toFixed(1)}%`)
await p.$disconnect(); process.exit(0)
