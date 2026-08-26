import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<Array<{ m: Date; n: bigint }>>(
  `SELECT date_trunc('minute', "updatedAt") AS m, COUNT(*)::bigint AS n
   FROM "Campaign" WHERE "updatedAt" >= now() - interval '24 hours'
   GROUP BY 1 ORDER BY 1 DESC`)
console.log(`\n── Campaign.updatedAt: distinct MINUTES holding a change, last 24h ──`)
console.log(`  distinct minutes with >=1 campaign row touched : ${rows.length}  (of 1440)`)
console.log(`  total campaign rows touched                    : ${rows.reduce((s, r) => s + Number(r.n), 0)}`)
console.log(`  most recent 12 bursts:`)
for (const r of rows.slice(0, 12)) console.log(`     ${r.m.toISOString().slice(0, 16)}  ${r.n} campaigns`)
const budgetMins = await prisma.$queryRawUnsafe<Array<{ m: Date; n: bigint }>>(
  `SELECT date_trunc('minute', "createdAt") AS m, COUNT(*)::bigint AS n
   FROM "AdvertisingActionLog" WHERE "actionType" = 'AD_BUDGET_UPDATE' AND "createdAt" >= now() - interval '48 hours'
   GROUP BY 1 ORDER BY 1 DESC`)
console.log(`\n── AD_BUDGET_UPDATE: distinct minutes, last 48h : ${budgetMins.length}`)
for (const r of budgetMins) console.log(`     ${r.m.toISOString().slice(0, 16)}  ${r.n} writes`)
console.log(`\n  → a 45 s poll on campaignsAt fires a false "changed" ~${rows.length} times/day; real budget changes: ${budgetMins.reduce((s,r)=>s+Number(r.n),0)} in 48h`)
await prisma.$disconnect()
