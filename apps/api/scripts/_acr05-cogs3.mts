import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<any[]>(s)
const show=(r:any[])=>r.length?r.forEach(x=>console.log(' ',Object.entries(x).map(([k,v])=>`${k}=${typeof v==='bigint'?Number(v):v}`).join('  '))):console.log('  (none)')
console.log('— weightedAvgCostCents: null vs zero vs real —')
show(await q(`SELECT
  COUNT(*)::int AS products,
  COUNT(*) FILTER (WHERE "weightedAvgCostCents" IS NULL)::int AS is_null,
  COUNT(*) FILTER (WHERE "weightedAvgCostCents" = 0)::int AS is_zero,
  COUNT(*) FILTER (WHERE "weightedAvgCostCents" > 0)::int AS is_real
  FROM "Product"`))
console.log('\n— trueProfit on campaigns: what is being SHOWN in the console —')
show(await q(`SELECT COUNT(*)::int AS campaigns,
  COUNT("trueProfitCents")::int AS with_true_profit,
  ROUND((SUM("trueProfitCents")/100.0)::numeric,2) AS sum_true_profit_eur
  FROM "Campaign"`))
await p.$disconnect(); process.exit(0)
