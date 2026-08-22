/** PLC-P6 — which starter criteria a placement rule can actually match today. Read-only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { buildCampaignBudgetContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')

for (const win of [7, 30]) {
  const ctxs = await buildCampaignBudgetContexts(win)
  const enabled = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, liveBidWritesEnabled: true, dynamicBidding: true } })
  const gate = new Map(enabled.map((c) => [c.id, c.liveBidWritesEnabled]))
  type PB = { placementBidding?: Array<{ placement: string; percentage: number }> }
  const lane = (id: string, l: string) => {
    const c = enabled.find((x) => x.id === id)
    return (((c?.dynamicBidding as PB | null)?.placementBidding) ?? []).find((x) => x.placement === l)?.percentage ?? 0
  }
  const reach = ctxs.filter((c) => gate.get(c.campaign.id))
  const pct = (n: number) => `${n}`.padStart(3)
  console.log(`\n═══ ${win}-day settled window · ${reach.length} reachable campaigns ═══`)
  const shapes: Array<[string, (c: typeof reach[number]) => boolean]> = [
    ['Sales = 0 AND Clicks >= 20', (c) => c.campaign.salesCents === 0 && c.campaign.clicks >= 20],
    ['Sales = 0 AND Clicks >= 10', (c) => c.campaign.salesCents === 0 && c.campaign.clicks >= 10],
    ['Sales = 0 AND Spend >= EUR10', (c) => c.campaign.salesCents === 0 && c.campaign.spendCents >= 1000],
    ['ACoS >= 60% AND Spend >= EUR10', (c) => c.campaign.acos != null && c.campaign.acos >= 0.6 && c.campaign.spendCents >= 1000],
    ['ACoS >= 40% AND Spend >= EUR10', (c) => c.campaign.acos != null && c.campaign.acos >= 0.4 && c.campaign.spendCents >= 1000],
    ['ACoS >= 30% AND Clicks >= 20', (c) => c.campaign.acos != null && c.campaign.acos >= 0.3 && c.campaign.clicks >= 20],
    ['ACoS <= 25% AND Orders >= 2', (c) => c.campaign.acos != null && c.campaign.acos <= 0.25 && c.campaign.orders >= 2],
    ['ACoS <= 20% AND Orders >= 3', (c) => c.campaign.acos != null && c.campaign.acos <= 0.2 && c.campaign.orders >= 3],
    ['ACoS <= 30% AND Orders >= 2', (c) => c.campaign.acos != null && c.campaign.acos <= 0.3 && c.campaign.orders >= 2],
    ['CTR <= 0.3% AND Impressions >= 500', (c) => c.campaign.ctr != null && c.campaign.ctr <= 0.003 && c.campaign.impressions >= 500],
  ]
  for (const [label, f] of shapes) {
    const hit = reach.filter(f)
    const tosNonZero = hit.filter((c) => lane(c.campaign.id, 'PLACEMENT_TOP') > 0).length
    const pdpNonZero = hit.filter((c) => lane(c.campaign.id, 'PLACEMENT_PRODUCT_PAGE') > 0).length
    const rosNonZero = hit.filter((c) => lane(c.campaign.id, 'PLACEMENT_REST_OF_SEARCH') > 0).length
    console.log(`  ${label.padEnd(34)} matches ${pct(hit.length)}   (of those, lane already non-zero: TOP ${pct(tosNonZero)} · PDP ${pct(pdpNonZero)} · ROS ${pct(rosNonZero)})`)
  }
}
await prisma.$disconnect()
