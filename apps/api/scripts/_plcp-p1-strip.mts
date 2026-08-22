/**
 * PLC-P1 verification — imports the SERVICE (so it tests the endpoint's own logic, not a
 * re-implementation) and re-derives every number by an independent route. Read-only.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getPlacementRulesStrip } = await import('../src/services/advertising/placement-grid.service.js')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name} — ${detail}`)
  ok ? pass++ : fail++
}

const s = await getPlacementRulesStrip()
console.log('strip:', JSON.stringify(s, null, 2))
console.log('')

// ── independent re-derivation ────────────────────────────────────────────────
const enabled = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, liveBidWritesEnabled: true } })
check('windowDays is the trigger\'s own', s.windowDays === 7, `${s.windowDays} (CAMPAIGN_PERFORMANCE_BUDGET)`)
check('enabledCampaigns', s.enabledCampaigns === enabled.length, `${s.enabledCampaigns} vs ${enabled.length}`)

// the context floor, rebuilt the way buildCampaignBudgetContexts builds it
const { ruleWindowBounds } = await import('@nexus/shared/data-vintage')
const { since, until } = ruleWindowBounds(s.windowDays)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', localEntityId: { in: enabled.map((c) => c.id) }, date: { gte: since, lte: until } },
  _sum: { costMicros: true },
})
const spendIds = new Set(perf.filter((p) => Number(p._sum.costMicros ?? 0) > 0).map((p) => p.localEntityId!))
check('measurable = ENABLED ∧ spend in the settled window', s.measurable === spendIds.size, `${s.measurable} vs ${spendIds.size}`)

const gateIds = enabled.filter((c) => spendIds.has(c.id) && c.liveBidWritesEnabled).map((c) => c.id)
check('gateOpen ⊆ measurable', s.gateOpen === gateIds.length && s.gateOpen <= s.measurable, `${s.gateOpen} vs ${gateIds.length}`)

const sched = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })
const govIds = new Set(sched.map((x) => x.campaignId))
const govCount = gateIds.filter((id) => govIds.has(id)).length
check('governed ⊆ gateOpen', s.governed === govCount && s.governed <= s.gateOpen, `${s.governed} vs ${govCount}`)
check('durable = gateOpen − governed', s.durable === s.gateOpen - s.governed, `${s.durable} = ${s.gateOpen} − ${s.governed}`)

// the lane ledger
const since7 = new Date(Date.now() - 7 * 864e5)
const rows = await prisma.campaignBidHistory.findMany({
  where: { changedAt: { gte: since7 }, field: { startsWith: 'PLACEMENT' }, changedBy: { startsWith: 'automation:' } },
  select: { campaignId: true, changedBy: true, changedAt: true },
})
check('engineWrites7d', s.engineWrites7d === rows.length, `${s.engineWrites7d} vs ${rows.length}`)
check('engineCampaigns7d', s.engineCampaigns7d === new Set(rows.filter((r) => r.campaignId).map((r) => r.campaignId)).size,
  `${s.engineCampaigns7d}`)
const ruleRows = rows.filter((r) => r.changedBy.startsWith('automation:rule-')).length
check('ruleWrites7d split from the rank loop', s.ruleWrites7d === ruleRows, `${s.ruleWrites7d} vs ${ruleRows}`)
check('ruleWrites7d ≤ engineWrites7d', s.ruleWrites7d <= s.engineWrites7d, `${s.ruleWrites7d} ≤ ${s.engineWrites7d}`)
const human = await prisma.campaignBidHistory.count({ where: { changedAt: { gte: new Date(Date.now() - 30 * 864e5) }, field: { startsWith: 'PLACEMENT' }, changedBy: { startsWith: 'user:' } } })
check('humanWrites30d', s.humanWrites30d === human, `${s.humanWrites30d} vs ${human}`)

// ── the claims the SENTENCE makes ────────────────────────────────────────────
check('the funnel nests (enabled ≥ measurable ≥ gateOpen ≥ governed)',
  s.enabledCampaigns >= s.measurable && s.measurable >= s.gateOpen && s.gateOpen >= s.governed,
  `${s.enabledCampaigns} ≥ ${s.measurable} ≥ ${s.gateOpen} ≥ ${s.governed}`)
check('no field is a fabricated zero standing in for a failed read',
  s.enabledCampaigns > 0 && s.measurable > 0, 'the service throws rather than returning [] — no .catch(() => [])')
check('engineLastWriteAt is inside the 7-day window or null',
  s.engineLastWriteAt == null || new Date(s.engineLastWriteAt) >= since7, `${s.engineLastWriteAt}`)
check('the strip carries NO current multiplier (a clock reading)',
  !Object.keys(s).some((k) => /carry|multiplier|current|pct/i.test(k)), Object.keys(s).join(', '))

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
