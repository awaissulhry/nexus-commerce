import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)
const show = (t: string, r: Record<string, unknown>[]) => { console.log('\n'+t); r.forEach(x=>console.log('  '+Object.entries(x).map(([k,v])=>`${k}=${typeof v==='bigint'?Number(v):v}`).join('  '))) }

show('Per-product COGS actually loaded?', await q(`
  SELECT COUNT(*)::int products,
         COUNT(*) FILTER (WHERE "costPrice" IS NOT NULL AND "costPrice" > 0)::int with_cost_price
  FROM "Product"`))
show('Campaign target ACOS configured?', await q(`
  SELECT COUNT(*)::int campaigns,
         COUNT(*) FILTER (WHERE "targetAcosPct" IS NOT NULL)::int with_target,
         ROUND(AVG("targetAcosPct")::numeric,1) avg_target
  FROM "Campaign"`))
show('Zero-sale spend, last 30d (waste that needs no margin)', await q(`
  SELECT ROUND((SUM("costMicros")/1000000.0)::numeric,2) wasted_eur, COUNT(*)::int rows
  FROM "AmazonAdsSearchTerm"
  WHERE date >= CURRENT_DATE - 30 AND clicks > 0 AND COALESCE("sales7dCents",0) = 0`))
show('...as a share of all search-term spend in the window', await q(`
  SELECT ROUND((SUM("costMicros")/1000000.0)::numeric,2) total_eur
  FROM "AmazonAdsSearchTerm" WHERE date >= CURRENT_DATE - 30`))
await p.$disconnect(); process.exit(0)
