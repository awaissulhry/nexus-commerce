import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
show('AdBudgetPlan — does ANY exist?', await q(`
  SELECT month, tag, "monthlyBudgetCents"/100 AS monthly_eur, "autoPacing", "stopOverSpend", marketplace
  FROM "AdBudgetPlan" ORDER BY month DESC LIMIT 8`))
show('total plans', await q(`SELECT COUNT(*) AS n FROM "AdBudgetPlan"`))
show('current month for reference', await q(`SELECT to_char(now(),'YYYY-MM') AS this_month`))
await p.$disconnect()
