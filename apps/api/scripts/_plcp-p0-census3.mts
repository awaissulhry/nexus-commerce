import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L = console.log
const H = (s: string) => L(`\n== ${s} ==`)

const enabled = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, marketplace: true, adProduct: true, dynamicBidding: true, liveBidWritesEnabled: true } })
const since = new Date(Date.now() - 9 * 864e5), until = new Date(Date.now() - 2 * 864e5)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: enabled.map(c => c.id) }, date: { gte: since, lte: until } }, _sum: { costMicros: true } })
const spendIds = new Set(perf.filter(p => Number(p._sum.costMicros ?? 0) > 0).map(p => p.localEntityId!))
const sc = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })
const govIds = new Set(sc.map(s => s.campaignId))
const d7 = new Date(Date.now() - 7 * 864e5)
const moved = await prisma.campaignBidHistory.findMany({ where: { changedAt: { gte: d7 }, field: { startsWith: 'PLACEMENT' }, changedBy: { startsWith: 'automation:' } }, select: { campaignId: true }, distinct: ['campaignId'] })
const movedIds = new Set(moved.map(m => m.campaignId!))

H('THE FUNNEL a placement rule actually passes through')
const sp = enabled.filter(c => c.adProduct === 'SPONSORED_PRODUCTS')
const spSpend = sp.filter(c => spendIds.has(c.id))
const spSpendGate = spSpend.filter(c => c.liveBidWritesEnabled)
const spSpendGateFree = spSpendGate.filter(c => !govIds.has(c.id))
const spSpendGateUntouched = spSpendGate.filter(c => !movedIds.has(c.id))
L(`  ENABLED campaigns                                     : ${enabled.length}`)
L(`  ...SPONSORED_PRODUCTS (placement = an SP construct)    : ${sp.length}`)
L(`  ...with spend in the 7 settled days (context floor)    : ${spSpend.length}`)
L(`  ...liveBidWritesEnabled (the write gate)               : ${spSpendGate.length}`)
L(`  ...NOT governed by an enabled AdSchedule               : ${spSpendGateFree.length}`)
L(`  ...whose lanes an automation did NOT rewrite in 7d     : ${spSpendGateUntouched.length}   <- durable reach`)
L(`  governed AND reachable (a rule can write, engine snaps back within the hour): ${spSpendGate.filter(c => govIds.has(c.id)).length}`)

H('per lane: how many of the reachable carry a value RIGHT NOW')
const now = new Date()
L(`  read at ${now.toISOString()} (Rome ${now.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })})`)
type PB = { placementBidding?: Array<{ placement: string; percentage: number }> }
const lanes = ['PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH']
for (const lane of lanes) {
  const n = spSpendGate.filter(c => (((c.dynamicBidding as PB | null)?.placementBidding) ?? []).some(x => x.placement === lane && Number(x.percentage) > 0)).length
  const nAbsent = spSpendGate.filter(c => !(((c.dynamicBidding as PB | null)?.placementBidding) ?? []).some(x => x.placement === lane)).length
  L(`  ${lane}: non-zero on ${n} of ${spSpendGate.length} reachable · lane ABSENT from the payload on ${nAbsent}`)
}
const engineLanes = await prisma.campaignBidHistory.groupBy({ by: ['field'], where: { changedAt: { gte: d7 }, field: { startsWith: 'PLACEMENT' }, changedBy: { startsWith: 'automation:' } }, _count: { _all: true } })
L(`  automation lane writes in 7d: ${JSON.stringify(engineLanes.map(g => [g.field, g._count._all]))}`)
const userLanes = await prisma.campaignBidHistory.groupBy({ by: ['field', 'changedBy'], where: { changedAt: { gte: new Date(Date.now() - 30 * 864e5) }, field: { startsWith: 'PLACEMENT' }, changedBy: { startsWith: 'user:' } }, _count: { _all: true } })
L(`  HUMAN lane writes in 30d: ${JSON.stringify(userLanes.map(g => [g.field, g.changedBy, g._count._all]))}`)

H('placement-report evidence per REACHABLE campaign (can an IF condition decide?)')
const p30 = new Date(Date.now() - 30 * 864e5)
const cells = await prisma.amazonAdsPlacementReport.groupBy({ by: ['localCampaignId', 'placement'], where: { date: { gte: p30 }, localCampaignId: { in: spSpendGate.map(c => c.id) } }, _sum: { clicks: true, costMicros: true, sales7dCents: true, impressions: true } })
const perLabel: Record<string, { cells: number; ge20: number; ge5: number }> = {}
for (const g of cells) {
  const k = g.placement
  perLabel[k] ??= { cells: 0, ge20: 0, ge5: 0 }
  perLabel[k].cells++
  if (Number(g._sum.clicks ?? 0) >= 20) perLabel[k].ge20++
  if (Number(g._sum.clicks ?? 0) >= 5) perLabel[k].ge5++
}
for (const [k, v] of Object.entries(perLabel)) L(`  "${k}": ${v.cells} campaign-cells · >=5 clicks/30d ${v.ge5} · >=20 clicks/30d ${v.ge20}`)
const p7 = new Date(Date.now() - 7 * 864e5)
const cells7 = await prisma.amazonAdsPlacementReport.groupBy({ by: ['localCampaignId', 'placement'], where: { date: { gte: p7 }, localCampaignId: { in: spSpendGate.map(c => c.id) } }, _sum: { clicks: true } })
const ge20_7 = cells7.filter(g => Number(g._sum.clicks ?? 0) >= 20).length
L(`  over 7 days: ${cells7.length} cells, ${ge20_7} clear 20 clicks  <- a short-window IF-placement rule is mostly unmeasurable`)

H('what the CAMPAIGN-wide context offers instead (what the engine really reads today)')
L(`  contexts a placement rule sees = buildCampaignBudgetContexts(7): ENABLED with spend = ${spSpend.length}`)
await prisma.$disconnect()
