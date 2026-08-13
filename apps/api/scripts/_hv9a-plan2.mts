/** HV.9a — plan write 1 with the page scoped to the destination's campaign. READ-ONLY. */
import '../src/env.js'
const { planPromotion } = await import('../src/services/advertising/harvest-promote.service.js')
const ID = 'DE|115625353077718|425987969360011|motorradjacke 4xl'
const CAMP = 'cmpedj38b04xdoj01g9mxye1y' // DE_Auto_Close — the campaign the ONE destination is stored against
for (const scope of [{}, { campaign: CAMP }] as const) {
  const plan = await planPromotion({ market: 'DE', candidateIds: [ID], userId: 'x', ...scope } as never)
  const r: any = plan.rows[0]
  console.log(`\n  scope=${JSON.stringify(scope)}`)
  if (!r) { console.log('    🔴 candidate not in the page rows at this scope'); continue }
  console.log(`    promotable=${r.promotable} dest=${r.destinationAdGroupName || '—'} (${r.destinationCampaignName || '—'})`)
  console.log(`    bid=${r.bidCents}c observedCpc=${r.observedCpcCents?.toFixed(2)}c clamped=${JSON.stringify(r.clamped)}`)
  console.log(`    wouldNegateAtSource=${r.wouldNegateAtSource}`)
  console.log(`    negateReason: ${r.negateReason}`)
  console.log(`    blocked=${JSON.stringify(r.blocked)}`)
  console.log(`    evidence: ${r.evidence?.note}`)
}
