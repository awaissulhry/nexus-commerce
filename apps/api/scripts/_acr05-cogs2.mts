import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<any[]>(s)
const show=(r:any[])=>r.length?r.forEach(x=>console.log(' ',Object.entries(x).map(([k,v])=>`${k}=${typeof v==='bigint'?Number(v):v}`).join('  '))):console.log('  (none)')
console.log('— ADVERTISED products: which cost source do they have? —')
show(await q(`SELECT COUNT(DISTINCT pr.id)::int AS advertised,
  COUNT(DISTINCT pr.id) FILTER (WHERE pr."costPrice" IS NOT NULL)::int AS with_cost_price,
  COUNT(DISTINCT pr.id) FILTER (WHERE pr."weightedAvgCostCents" IS NOT NULL)::int AS with_wac,
  COUNT(DISTINCT pr.id) FILTER (WHERE pr."costPrice" IS NULL AND pr."weightedAvgCostCents" IS NULL)::int AS no_cost_at_all
  FROM "AdProductAd" a JOIN "Product" pr ON pr.id = a."productId"`))
console.log('\n— ProductProfitDaily: is cogsCents actually populated? —')
show(await q(`SELECT COUNT(*)::int AS rows,
  COUNT(*) FILTER (WHERE "cogsCents" > 0)::int AS with_cogs,
  COUNT(DISTINCT "productId")::int AS products,
  ROUND((SUM("cogsCents")/100.0)::numeric,2) AS total_cogs_eur
  FROM "ProductProfitDaily"`))
console.log('\n— how does true-profit source COGS? sample rows —')
show(await q(`SELECT pd."productId", pd.date::text AS d, pd."grossRevenueCents" AS rev_c, pd."cogsCents" AS cogs_c,
  pr."costPrice", pr."weightedAvgCostCents" AS wac_c
  FROM "ProductProfitDaily" pd JOIN "Product" pr ON pr.id = pd."productId"
  ORDER BY pd.date DESC LIMIT 5`))
await p.$disconnect(); process.exit(0)
