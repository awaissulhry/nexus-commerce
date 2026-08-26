import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)
const since7 = new Date(Date.now()-7*24*3600e3)
const oq = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { syncType: 'AD_BUDGET_UPDATE', createdAt: { gte: since7 } }, _count: { _all: true } })
out('OutboundSyncQueue AD_BUDGET_UPDATE, 7d — the DELIVERY truth')
for (const r of oq) console.log(`  · ${r.syncStatus}: ${r._count._all}`)
const fails = await prisma.outboundSyncQueue.findMany({ where: { syncType: 'AD_BUDGET_UPDATE', createdAt: { gte: since7 }, syncStatus: 'SKIPPED' }, take: 6, orderBy: { createdAt: 'desc' } })
for (const f of fails) console.log(`    ! ${f.id} status=${f.syncStatus} attempts=${(f as any).attempts ?? '—'} err=${String((f as any).lastError ?? (f as any).errorMessage ?? '—').slice(0,140)}`)

// actor split
const rows = await prisma.advertisingActionLog.groupBy({ by: ['userId'], where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: since7 } }, _count: { _all: true } })
out(`AD_BUDGET_UPDATE actors, 7d (total ${rows.reduce((a,r)=>a+r._count._all,0)})`)
for (const r of rows.sort((a,b)=>b._count._all-a._count._all)) console.log(`  · ${r.userId ?? 'null'} — ${r._count._all}`)

const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { marketplace: true, dailyBudget: true, budgetBaselineCents: true } })
const floor = camps.filter(c=>Number(c.dailyBudget??0)<=1).length
out(`ENABLED campaigns ${camps.length}; at the €1 floor ${floor}; with a captured baseline ${camps.filter(c=>c.budgetBaselineCents!=null).length}`)
const byMkt = new Map<string,{n:number;f:number;s:number}>()
for (const c of camps){const k=c.marketplace??'—';const e=byMkt.get(k)??{n:0,f:0,s:0};e.n++;if(Number(c.dailyBudget??0)<=1)e.f++;e.s+=Number(c.dailyBudget??0);byMkt.set(k,e)}
for (const [k,v] of [...byMkt].sort((a,b)=>b[1].n-a[1].n)) console.log(`  · ${k}: ${v.n} enabled, ${v.f} at floor, €${v.s.toFixed(2)}/day of budget`)

// 24h rewrite churn
const raw = await prisma.$queryRaw<Array<{ entityId: string; n: bigint }>>`
  SELECT "entityId", COUNT(*) n FROM "AdvertisingActionLog" WHERE "actionType"='AD_BUDGET_UPDATE' AND "createdAt" >= NOW() - INTERVAL '24 hours' GROUP BY 1 ORDER BY n DESC LIMIT 8`
out('Most-rewritten campaigns, 24h — how fast another writer would overrun a schedule')
for (const r of raw) { const c = await prisma.campaign.findUnique({ where: { id: r.entityId }, select: { name: true, marketplace: true, dailyBudget: true } }); console.log(`  · ${c?.marketplace ?? '?'} ${c?.name ?? r.entityId} — ${Number(r.n)} writes, now €${Number(c?.dailyBudget??0).toFixed(2)}`) }
await prisma.$disconnect()
