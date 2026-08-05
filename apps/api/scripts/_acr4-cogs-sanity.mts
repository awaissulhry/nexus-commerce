/** ACR.4 — what target ACOS would a flat EUR 50 cost produce? READ-ONLY. */
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

h('1. what do the ADVERTISED products actually sell for?')
show(await q(`
  SELECT ROUND(MIN(d."grossRevenueCents"/NULLIF(d."unitsSold",0)/100.0)::numeric,2) AS min_price,
         ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY d."grossRevenueCents"/NULLIF(d."unitsSold",0)/100.0))::numeric,2) AS median_price,
         ROUND(MAX(d."grossRevenueCents"/NULLIF(d."unitsSold",0)/100.0)::numeric,2) AS max_price,
         COUNT(*)::int AS product_days
  FROM "ProductProfitDaily" d WHERE d."unitsSold" > 0 AND d."grossRevenueCents" > 0`))

h('2. price distribution per product (30d), advertised only')
show(await q(`
  SELECT p.sku,
         ROUND((SUM(d."grossRevenueCents")/NULLIF(SUM(d."unitsSold"),0)/100.0)::numeric,2) AS avg_price_eur,
         SUM(d."unitsSold")::int AS units,
         ROUND((100.0*SUM(d."referralFeesCents"+d."fbaFulfillmentFeesCents")/NULLIF(SUM(d."grossRevenueCents"),0))::numeric,1) AS fees_pct
  FROM "ProductProfitDaily" d JOIN "Product" p ON p.id=d."productId"
  WHERE d."unitsSold" > 0 AND EXISTS (SELECT 1 FROM "AdProductAd" pa WHERE pa."productId"=d."productId")
  GROUP BY 1 ORDER BY units DESC`), 15)

h('3. so what break-even / target ACOS does a EUR 50 cost imply, per price point?')
console.log('  break-even = (price - 50 - fees) / price ;  target = break-even x (1 - 0.35 profit share)')
show(await q(`
  WITH pr AS (SELECT unnest(ARRAY[59.99, 69.99, 79.99, 89.99, 99.99, 119.99, 139.99]) AS price)
  SELECT price,
         ROUND((100.0*(price - 50 - price*0.20)/price)::numeric,1) AS breakeven_acos_pct,
         ROUND((100.0*(price - 50 - price*0.20)/price*0.65)::numeric,1) AS target_acos_pct
  FROM pr ORDER BY price`))

h('4. for reference — what ACOS are we actually running?')
show(await q(`
  SELECT ROUND((100.0*SUM(d."costMicros")/1e6/NULLIF(SUM(d."sales7dCents")/100.0,0))::numeric,1) AS actual_acos_pct,
         ROUND((SUM(d."costMicros")/1e6)::numeric,2) AS spend_eur,
         ROUND((SUM(d."sales7dCents")/100.0)::numeric,2) AS sales_eur
  FROM "AmazonAdsDailyPerformance" d
  WHERE d."entityType"='CAMPAIGN' AND d.date > now() - interval '30 days'`))

await p.$disconnect()
