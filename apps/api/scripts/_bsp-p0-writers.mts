import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)

const since7 = new Date(Date.now() - 7*24*3600e3)
const since1 = new Date(Date.now() - 24*3600e3)

const rows = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: since7 } }, _count: { _all: true },
})
out(`AD_BUDGET_UPDATE actors, 7d (total ${rows.reduce((a,r)=>a+r._count._all,0)})`)
for (const r of rows.sort((a,b)=>b._count._all-a._count._all)) console.log(`  · ${r.userId ?? 'null'} — ${r._count._all}`)

const rows1 = await prisma.advertisingActionLog.groupBy({
  by: ['userId'], where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: since1 } }, _count: { _all: true },
})
out(`AD_BUDGET_UPDATE actors, 24h (total ${rows1.reduce((a,r)=>a+r._count._all,0)})`)
for (const r of rows1.sort((a,b)=>b._count._all-a._count._all)) console.log(`  · ${r.userId ?? 'null'} — ${r._count._all}`)

const raw = await prisma.$queryRaw<Array<{ entityId: string; n: bigint }>>`
  SELECT "entityId", COUNT(*) AS n FROM "AdvertisingActionLog"
  WHERE "actionType"='AD_BUDGET_UPDATE' AND "createdAt" >= ${since1}
  GROUP BY "entityId" ORDER BY n DESC LIMIT 10`
out(`Most-rewritten campaigns in 24h`)
for (const r of raw) console.log(`  · ${r.entityId} — ${Number(r.n)} budget writes`)

const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, dailyBudget: true, budgetBaselineCents: true, adProduct: true } })
const at1 = camps.filter((c) => Number(c.dailyBudget ?? 0) <= 1)
out(`ENABLED campaigns ${camps.length}; at/below the €1 floor: ${at1.length}; with a captured baseline: ${camps.filter(c=>c.budgetBaselineCents!=null).length}`)
const byMkt = new Map<string, {n:number; floor:number; sum:number}>()
for (const c of camps) { const k=c.marketplace??'—'; const e=byMkt.get(k)??{n:0,floor:0,sum:0}; e.n++; if(Number(c.dailyBudget??0)<=1) e.floor++; e.sum+=Number(c.dailyBudget??0); byMkt.set(k,e) }
for (const [k,v] of [...byMkt].sort((a,b)=>b[1].n-a[1].n)) console.log(`  · ${k}: ${v.n} enabled, ${v.floor} at floor, €${v.sum.toFixed(2)}/day total budget`)

await prisma.$disconnect()
