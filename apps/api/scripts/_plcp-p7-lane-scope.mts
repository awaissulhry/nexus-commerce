/**
 * PLC-P7 — does a lane-scoped criterion actually read THAT LANE? Read-only; writes nothing.
 *
 * The proof that matters is a DIFFERENCE: the same threshold, scoped campaign-wide vs scoped to a
 * lane, must select different campaigns. If they agree everywhere, the scope is still decorative.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewPlacementRule } = await import('../src/services/advertising/ads-rule-preview.service.js')
const { buildCampaignBudgetContexts } = await import('../src/jobs/advertising-rule-evaluator.job.js')

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d: string) => { console.log(`  ${ok ? '✓' : '✗'} ${n} — ${d}`); ok ? pass++ : fail++ }

// ── 1. the context really carries per-lane numbers, and they are not the campaign's ──
console.log('── the context ──')
const ctxs = await buildCampaignBudgetContexts(30)
check('every context carries all three lanes', ctxs.every((c) => c.placement?.tos && c.placement?.pdp && c.placement?.ros), `${ctxs.length} contexts`)
const withLane = ctxs.filter((c) => c.placement.tos.clicks != null && (c.placement.tos.clicks ?? 0) > 0)
check('lanes carry real measured clicks', withLane.length > 0, `${withLane.length} of ${ctxs.length} campaigns have Top-of-Search clicks in 30 settled days`)
const unmeasured = ctxs.filter((c) => c.placement.pdp.clicks == null)
check('🔴 an unmeasured lane is NULL, never 0', ctxs.every((c) => (c.placement.pdp.clicks == null) === (c.placement.pdp.acos == null && c.placement.pdp.ctr == null) || c.placement.pdp.clicks != null),
  `${unmeasured.length} campaigns have no Product Pages rows — all-null, so every comparison fails`)
const sample = withLane[0]
if (sample) {
  const t = sample.placement.tos
  console.log(`      e.g. ${sample.campaign.name}: campaign ${sample.campaign.clicks} clicks / ACoS ${sample.campaign.acos == null ? 'n/a' : (sample.campaign.acos * 100).toFixed(0) + '%'}`)
  console.log(`           Top of Search lane: ${t.clicks} clicks / ACoS ${t.acos == null ? 'n/a' : (t.acos * 100).toFixed(0) + '%'} / CTR ${t.ctr == null ? 'n/a' : (t.ctr * 100).toFixed(2) + '%'}`)
}
const laneSum = ctxs.filter((c) => c.campaign.clicks > 0).map((c) => ({
  name: c.campaign.name, camp: c.campaign.clicks,
  lanes: (c.placement.tos.clicks ?? 0) + (c.placement.pdp.clicks ?? 0) + (c.placement.ros.clicks ?? 0),
}))
const agree = laneSum.filter((x) => x.lanes > 0 && Math.abs(x.lanes - x.camp) / x.camp < 0.25).length
check('lane clicks reconcile with campaign clicks (±25%) where both exist', agree > 0, `${agree} of ${laneSum.filter((x) => x.lanes > 0).length} campaigns reconcile — two independent Amazon reports, so exact equality is not expected`)

// ── 2. the same threshold, campaign-wide vs lane-scoped, must SELECT DIFFERENTLY ──
console.log('\n── campaign-wide vs lane-scoped, same threshold ──')
const picked = (await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true } })).map((c) => ({ id: c.id }))
const draft = (scope: string) => ({
  actions: [{ type: 'placement', campaigns: picked, placeFloor: 0, placeCeiling: 900, windowDays: 30 }],
  conditions: [{
    match: 'all',
    action: { op: 'decPct', value: '20', placeTarget: 'tos' },
    conditions: [{ metric: 'CTR', op: 'lte', value: '0.3', scope }, { metric: 'Impressions', op: 'gte', value: '500', scope }],
  }],
  scopeMarketplace: null,
})
const wide = await previewPlacementRule(draft('campaign'))
const lane = await previewPlacementRule(draft('tos'))
check('both drafts translate and run', wide.ok && lane.ok, `campaign ok=${wide.ok} · lane ok=${lane.ok}`)
console.log(`      campaign-wide "CTR ≤ 0.3% AND impressions ≥ 500": ${wide.matched} match`)
console.log(`      Top-of-Search  "CTR ≤ 0.3% AND impressions ≥ 500": ${lane.matched} match`)
check('🔴 the lane-scoped rule selects a DIFFERENT set — the scope is not decorative',
  wide.matched !== lane.matched, `${wide.matched} vs ${lane.matched}`)
const wideNames = new Set(wide.rows.map((r) => r.campaign))
const laneNames = new Set(lane.rows.map((r) => r.campaign))
const onlyLane = [...laneNames].filter((n) => !wideNames.has(n))
const onlyWide = [...wideNames].filter((n) => !laneNames.has(n))
console.log(`      only the lane rule catches: ${onlyLane.slice(0, 4).join(', ') || '(none)'}`)
console.log(`      only the campaign rule catches: ${onlyWide.slice(0, 4).join(', ') || '(none)'}`)
check('the two sets genuinely differ in membership, not just in count', onlyLane.length + onlyWide.length > 0, `${onlyLane.length} lane-only + ${onlyWide.length} campaign-only`)

// ── 3. a lane with no data must not be swept in by a `lte` ──
console.log('\n── the null discipline ──')
const pdpDraft = await previewPlacementRule({
  actions: [{ type: 'placement', campaigns: picked, placeFloor: 0, placeCeiling: 900, windowDays: 30 }],
  conditions: [{ match: 'all', action: { op: 'set', value: '0', placeTarget: 'pdp' }, conditions: [{ metric: 'CTR', op: 'lte', value: '99', scope: 'pdp' }] }],
  scopeMarketplace: null,
})
const pdpMeasured = ctxs.filter((c) => c.placement.pdp.ctr != null).length
check('🔴 "CTR ≤ 99%" on a lane matches only campaigns that HAVE that lane measured',
  pdpDraft.matched <= pdpMeasured, `${pdpDraft.matched} matched vs ${pdpMeasured} with measurable Product Pages CTR (of ${ctxs.length})`)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
