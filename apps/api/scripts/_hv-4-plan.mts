/**
 * HV.4 — the plan, proven WITHOUT writing anything. READ-ONLY.
 *
 * Everything the confirm dialog will state, computed by the same function the write executes, so
 * the two cannot diverge. This is the pre-flight for the single live write.
 */
import '../src/env.js'
const { planPromotion, deriveBid } = await import('../src/services/advertising/harvest-promote.service.js')
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

// the bid derivation, in isolation — including the clamp no current candidate exercises
console.log('\n═══ 1 · deriveBid, including the clamp ═══\n')
for (const c of [
  { label: 'motorradjacke 4xl (DE, real)', spendCents: 364, clicks: 6, ceilingCents: 190, campaignName: 'DE_Exact_3_Keywords' },
  { label: 'above the IT ceiling', spendCents: 12600, clicks: 100, ceilingCents: 80, campaignName: 'GALE | IT | Exact' },
  { label: 'no clicks → floor', spendCents: 0, clicks: 0, ceilingCents: 190, campaignName: 'x' },
  { label: 'no ceiling set', spendCents: 500, clicks: 2, ceilingCents: null, campaignName: 'y' },
]) {
  const b = deriveBid(c)
  console.log(`  ${pad(c.label, 30)} observed=${pad(b.observedCpcCents == null ? '—' : eur(b.observedCpcCents), 8)} → write ${pad(eur(b.bidCents), 8)} ${b.clamped ? `🔴 CLAMPED from ${eur(b.clamped.from)} by ${c.campaignName}'s ${eur(b.clamped.ceilingCents)} ceiling` : 'not clamped'}`)
}

console.log('\n═══ 2 · the plan for every current candidate ═══\n')
const page = await getKeywordHarvest({ market: 'all' })
const plan = await planPromotion({ market: 'all', candidateIds: page.rows.map((r) => r.id) })
console.log(`reach: ${plan.reach.campaigns} of ${plan.reach.ofTotal} campaigns · promotable ${plan.promotable} · blocked ${plan.blocked}\n`)
console.log(`${pad('term', 30)} ${pad('bid', 8)} ${pad('dest', 24)} ${pad('negate?', 8)} ${pad('promotable', 11)} why not`)
for (const r of plan.rows) {
  console.log(`${pad(r.term, 30)} ${pad(eur(r.bidCents), 8)} ${pad(r.destinationAdGroupName || '(none)', 24)} ${pad(r.wouldNegateAtSource ? 'YES' : 'no', 8)} ${pad(r.promotable ? 'yes' : 'NO', 11)} ${r.promotable ? '' : (r.blocked ? `${r.blocked.half}: ${r.blocked.deniedAt}` : 'no destination chosen')}`)
}
console.log('\nevidence that would be recorded on the first row:')
console.log(`  ${JSON.stringify(plan.rows[0]?.evidence)}`)
await prisma.$disconnect()
