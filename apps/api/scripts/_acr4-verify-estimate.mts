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

h('the honest breakdown')
show(await q(`
  SELECT ("coverage"->>'hasCostPrice')::boolean AS real_cost,
         ("coverage"->>'costEstimated')::boolean AS estimated,
         "grossRevenueCents" > 0 AS has_revenue,
         "trueProfitCents" IS NOT NULL AS has_profit,
         COUNT(*)::int AS rows
  FROM "ProductProfitDaily" GROUP BY 1,2,3,4 ORDER BY 5 DESC`), 12)

h('the 13 rows claiming a REAL cost — is that right, or is my flag leaking?')
show(await q(`
  SELECT p.sku, d."cogsCents", d."grossRevenueCents", d."unitsSold",
         pr."costPrice", pr."weightedAvgCostCents"
  FROM "ProductProfitDaily" d JOIN "Product" p ON p.id=d."productId"
  JOIN "Product" pr ON pr.id=d."productId"
  WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE LIMIT 8`))

h('sanity: estimated cogs vs price, to confirm the cap is doing its job')
show(await q(`
  SELECT ROUND((d."grossRevenueCents"/NULLIF(d."unitsSold",0)/100.0)::numeric,2) AS unit_price_eur,
         ROUND((d."cogsCents"/NULLIF(d."unitsSold",0)/100.0)::numeric,2) AS est_unit_cost_eur,
         ROUND((100.0*d."cogsCents"/NULLIF(d."grossRevenueCents",0))::numeric,0) AS cost_pct_of_price,
         COUNT(*)::int AS rows
  FROM "ProductProfitDaily" d WHERE ("coverage"->>'costEstimated')::boolean IS TRUE AND d."unitsSold">0
  GROUP BY 1,2,3 ORDER BY 1 LIMIT 12`), 12)

await p.$disconnect()
