import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString().slice(0,10) : v)
const show = (t: string, rows: Record<string, unknown>[]) => { console.log('\n' + t); rows.length ? rows.forEach(r => console.log('  ' + Object.entries(r).map(([k,v])=>`${k}=${n(v)}`).join('  '))) : console.log('  (none)') }

show('DailySalesAggregate — coverage', await q(`
  SELECT channel, COUNT(*)::int rows, MIN(day)::date first_day, MAX(day)::date last_day,
         COUNT(DISTINCT day)::int days, COUNT(DISTINCT marketplace)::int markets,
         ROUND(SUM("grossRevenue")::numeric,2) gross
  FROM "DailySalesAggregate" GROUP BY 1 ORDER BY 2 DESC`))

show('DailySalesAggregate — by marketplace, last 30d', await q(`
  SELECT marketplace, COUNT(*)::int rows, MAX(day)::date last_day, ROUND(SUM("grossRevenue")::numeric,2) gross
  FROM "DailySalesAggregate" WHERE day >= CURRENT_DATE - 30 GROUP BY 1 ORDER BY 4 DESC NULLS LAST`))

show('ProductProfitDaily — coverage', await q(`
  SELECT COUNT(*)::int rows, MIN(date)::date first_day, MAX(date)::date last_day,
         COUNT(DISTINCT date)::int days, COUNT(DISTINCT marketplace)::int markets,
         SUM("grossRevenueCents")::bigint gross_cents, SUM("cogsCents")::bigint cogs_cents,
         COUNT(*) FILTER (WHERE "cogsCents" > 0)::int rows_with_cogs
  FROM "ProductProfitDaily"`))

show('Order — coverage (the fallback for total sales)', await q(`
  SELECT COUNT(*)::int orders, MIN("orderDate")::date first_day, MAX("orderDate")::date last_day,
         COUNT(DISTINCT marketplace)::int markets
  FROM "Order" WHERE "orderDate" >= CURRENT_DATE - 120`))

show('Do we have per-product COGS at all?', await q(`
  SELECT COUNT(*)::int products, COUNT(*) FILTER (WHERE "costPrice" IS NOT NULL AND "costPrice" > 0)::int with_cost
  FROM "Product"`))
await p.$disconnect(); process.exit(0)
