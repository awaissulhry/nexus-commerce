import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<any[]>(s)
const show=(r:any[])=>r.length?r.forEach(x=>console.log(' ',Object.entries(x).map(([k,v])=>`${k}=${typeof v==='bigint'?Number(v):v}`).join('  '))):console.log('  (none)')
console.log('— cost coverage across products —')
show(await q(`SELECT COUNT(*)::int AS products,
  COUNT("costPrice")::int AS with_cost_price,
  COUNT("weightedAvgCostCents")::int AS with_wac,
  COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND status='ACTIVE')::int AS active
  FROM "Product"`))
console.log('\n— of the products actually being ADVERTISED —')
show(await q(`SELECT COUNT(DISTINCT pr.id)::int AS advertised_products,
  COUNT(DISTINCT pr.id) FILTER (WHERE pr."costPrice" IS NOT NULL)::int AS with_cost
  FROM "AdProductAd" a
  JOIN "Product" pr ON pr.id = a."productId"`))
console.log('\n— does the import wizard actually offer costPrice, and has it ever run? —')
show(await q(`SELECT status, COUNT(*)::int AS jobs, MAX("createdAt")::text AS last
  FROM "ImportJob" GROUP BY 1 ORDER BY jobs DESC LIMIT 5`))
console.log('\n— ProductProfitDaily: does the profit spine have anything? —')
show(await q(`SELECT COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last
  FROM "ProductProfitDaily"`))
await p.$disconnect(); process.exit(0)
