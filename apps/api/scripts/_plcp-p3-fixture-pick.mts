/** PLC-P3 — pick the fixture campaign: durable reach, real evidence, no engine contest. Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleWindowBounds } = await import('@nexus/shared/data-vintage')

const enabled = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, dynamicBidding: true, liveBidWritesEnabled: true },
})
const { since, until } = ruleWindowBounds(7)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', localEntityId: { in: enabled.map((c) => c.id) }, date: { gte: since, lte: until } },
  _sum: { costMicros: true, clicks: true, sales7dCents: true, sales14dCents: true },
})
const byId = new Map(perf.map((p) => [p.localEntityId!, p]))
const govIds = new Set((await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })).map((s) => s.campaignId))
const moved = new Set((await prisma.campaignBidHistory.findMany({
  where: { changedAt: { gte: new Date(Date.now() - 7 * 864e5) }, field: { startsWith: 'PLACEMENT' }, changedBy: { startsWith: 'automation:' } },
  select: { campaignId: true }, distinct: ['campaignId'],
})).map((m) => m.campaignId!))

type PB = { placementBidding?: Array<{ placement: string; percentage: number }> }
const rows = enabled
  .filter((c) => c.liveBidWritesEnabled && !govIds.has(c.id) && !moved.has(c.id))
  .map((c) => {
    const p = byId.get(c.id)
    const spendCents = Math.round(Number(p?._sum.costMicros ?? 0) / 1e4)
    const salesCents = (p?._sum.sales7dCents ?? 0) + (p?._sum.sales14dCents ?? 0)
    const clicks = p?._sum.clicks ?? 0
    const tos = ((c.dynamicBidding as PB | null)?.placementBidding ?? []).find((x) => x.placement === 'PLACEMENT_TOP')?.percentage ?? 0
    return { id: c.id, name: c.name, mkt: c.marketplace, spendEur: spendCents / 100, clicks, acosPct: salesCents > 0 ? (spendCents / salesCents) * 100 : null, tosPct: tos }
  })
  .filter((r) => r.spendEur > 0)
  .sort((a, b) => b.clicks - a.clicks)

console.log(`durable-reach candidates with spend in the 7 settled days: ${rows.length}\n`)
console.log('name'.padEnd(38), 'mkt', 'clicks'.padStart(7), 'spend'.padStart(9), 'ACoS'.padStart(8), 'TOS now'.padStart(8))
for (const r of rows.slice(0, 15)) {
  console.log(r.name.slice(0, 37).padEnd(38), (r.mkt ?? '—').padEnd(3), String(r.clicks).padStart(7), `€${r.spendEur.toFixed(2)}`.padStart(9), (r.acosPct != null ? `${r.acosPct.toFixed(0)}%` : 'no sales').padStart(8), `${r.tosPct}%`.padStart(8))
}
console.log('\n🔴 the fixture must be one a "ACoS ≥ 40% AND clicks ≥ 20" rule can actually MATCH today,')
console.log('   or the grid shows a rule and the Suggestions page shows nothing, which proves nothing.')
const matches = rows.filter((r) => r.acosPct != null && r.acosPct >= 40 && r.clicks >= 20)
console.log(`\ncampaigns matching ACoS >= 40% AND clicks >= 20 right now: ${matches.length}`)
for (const m of matches) console.log(`  ${m.name} [${m.id}] ${m.mkt} · ${m.clicks} clicks · ACoS ${m.acosPct!.toFixed(0)}% · TOS ${m.tosPct}%`)
await prisma.$disconnect()
