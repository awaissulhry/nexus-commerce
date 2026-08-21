import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleWindowBounds } = await import('@nexus/shared/data-vintage')
const { microsToCents } = await import('../src/services/ads-core/metrics-math.js')
const { since, until } = ruleWindowBounds(7)
const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, dailyBudget: true } })
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: camps.map(c => c.id) }, date: { gte: since, lte: until } },
  _sum: { costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true },
})
const byId = new Map(perf.map(p => [p.localEntityId!, p]))
const rows: Array<{ n: string; acos: number | null; spend: number; util: number | null; budget: number }> = []
for (const c of camps) {
  const p = byId.get(c.id); const spendCents = microsToCents(p?._sum.costMicros)
  if (spendCents === 0) continue
  const budgetCents = Math.round(Number(c.dailyBudget) * 100)
  const salesCents = (p?._sum.sales7dCents ?? 0) + (p?._sum.sales14dCents ?? 0)
  rows.push({ n: c.name.slice(0, 34), acos: salesCents > 0 ? spendCents / salesCents : null, spend: spendCents / 100, util: budgetCents > 0 ? (spendCents / 7) / budgetCents : null, budget: budgetCents / 100 })
}
const withAcos = rows.filter(r => r.acos != null)
const noSales = rows.filter(r => r.acos == null)
console.log(`reachable ${rows.length} · with sales (ACoS measurable) ${withAcos.length} · ZERO sales (ACoS null -> fails every ACoS condition) ${noSales.length}`)
for (const [lo, hi] of [[0,.1],[.1,.2],[.2,.3],[.3,.4],[.4,1],[1,99]]) {
  console.log(`  ACoS ${(lo*100).toFixed(0)}-${hi>=99?'inf':(hi*100).toFixed(0)}%: ${withAcos.filter(r => r.acos! >= lo && r.acos! < hi).length}`)
}
console.log(`spend in window: >=EUR50 ${rows.filter(r=>r.spend>=50).length} · >=EUR20 ${rows.filter(r=>r.spend>=20).length} · >=EUR5 ${rows.filter(r=>r.spend>=5).length}`)
console.log(`top spenders:`); for (const r of [...rows].sort((a,b)=>b.spend-a.spend).slice(0,6)) console.log(`  ${r.n.padEnd(35)} EUR${r.spend.toFixed(2).padStart(8)} budget EUR${r.budget.toFixed(2)} acos ${r.acos==null?'n/a':(r.acos*100).toFixed(1)+'%'} util ${r.util==null?'n/a':(r.util*100).toFixed(0)+'%'}`)
await prisma.$disconnect()
