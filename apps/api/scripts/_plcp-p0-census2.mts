import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L = console.log
const H = (s: string) => L(`\n== ${s} ==`)

H('A. the three surviving advertising rules')
const all = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, scopeMarketplace: true } })
for (const r of all) L(`  "${r.name}" enabled=${r.enabled} autonomy=${r.autonomyLevel} trigger=${r.trigger} actions=${JSON.stringify((r.actions as Array<{type?:string}>).map(a=>a?.type))}`)

H('B. adProduct on campaigns')
const ap = await prisma.campaign.groupBy({ by: ['adProduct', 'status'], _count: { _all: true } })
for (const g of ap) L(`  adProduct=${JSON.stringify(g.adProduct)} status=${g.status}: ${g._count._all}`)

H('C. who writes placement lanes (CampaignBidHistory 30d)')
const d30 = new Date(Date.now() - 30 * 864e5)
const by = await prisma.campaignBidHistory.groupBy({ by: ['changedBy', 'field'], where: { changedAt: { gte: d30 }, field: { startsWith: 'PLACEMENT' } }, _count: { _all: true } })
for (const g of by.sort((a,b)=>b._count._all-a._count._all)) L(`  ${g.changedBy} -> ${g.field}: ${g._count._all}`)
const d7 = new Date(Date.now() - 7 * 864e5)
const by7 = await prisma.campaignBidHistory.groupBy({ by: ['changedBy'], where: { changedAt: { gte: d7 }, field: { startsWith: 'PLACEMENT' } }, _count: { _all: true } })
L(`  7d by actor: ${JSON.stringify(by7.map(g=>[g.changedBy,g._count._all]))}`)
const distinctCamps = await prisma.campaignBidHistory.findMany({ where: { changedAt: { gte: d7 }, field: { startsWith: 'PLACEMENT' } }, select: { campaignId: true }, distinct: ['campaignId'] })
L(`  distinct campaigns whose lanes moved in 7d: ${distinctCamps.length}`)

H('D. sample of recent placement writes')
const recent = await prisma.campaignBidHistory.findMany({ where: { field: { startsWith: 'PLACEMENT' } }, orderBy: { changedAt: 'desc' }, take: 12, select: { field: true, oldValue: true, newValue: true, changedBy: true, reason: true, changedAt: true } })
for (const r of recent) L(`  ${r.changedAt.toISOString()} ${r.field} ${r.oldValue}->${r.newValue} by ${r.changedBy} · ${r.reason}`)

H('E. AdSchedule governance vs the 70 enabled')
const sc = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { id: true, campaignId: true, lastApplied: true, lastEvaluatedAt: true } })
L(`  enabled schedules: ${sc.length} · distinct campaigns: ${new Set(sc.map(s=>s.campaignId)).size}`)
L(`  with lastApplied: ${sc.filter(s=>s.lastApplied).length} · evaluated in last 2h: ${sc.filter(s=>s.lastEvaluatedAt && s.lastEvaluatedAt > new Date(Date.now()-2*36e5)).length}`)
const enabledIds = new Set((await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true } })).map(c=>c.id))
L(`  governed AND ENABLED: ${sc.filter(s=>enabledIds.has(s.campaignId)).length}`)

H('F. suggestion tables')
const models = Object.keys(prisma).filter(k => /sugg/i.test(k))
L(`  models: ${JSON.stringify(models)}`)
for (const m of models) {
  try { const n = await (prisma as unknown as Record<string, { count: () => Promise<number> }>)[m].count(); L(`   ${m}: ${n} rows`) } catch (e) { L(`   ${m}: ${String(e).slice(0,80)}`) }
}

H('G. placement report join')
const p30 = new Date(Date.now() - 30 * 864e5)
const rows = await prisma.amazonAdsPlacementReport.findMany({ where: { date: { gte: p30 } }, select: { placement: true, campaignId: true, localCampaignId: true, topOfSearchIS: true }, take: 4 })
for (const r of rows) L(`  placement=${JSON.stringify(r.placement)} external=${r.campaignId} local=${r.localCampaignId} tosIS=${r.topOfSearchIS}`)
const tosis = await prisma.amazonAdsPlacementReport.count({ where: { date: { gte: p30 }, topOfSearchIS: { not: null } } })
L(`  rows with topOfSearchIS: ${tosis}`)
await prisma.$disconnect()
