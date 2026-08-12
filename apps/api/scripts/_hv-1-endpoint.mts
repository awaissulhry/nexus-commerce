/**
 * HV.1 — the endpoint's own numbers, reproduced. READ-ONLY.
 *
 * Calls `getKeywordHarvest()` exactly as the route calls it and prints every value the page
 * renders, so each number on the screen can be checked against a re-runnable script rather than
 * against a screenshot. This is the script named in the doc for DoD #5.
 */
import '../src/env.js'
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ HV.1 — GET /advertising/keyword-harvest, defaults (market=all) ═══\n')

const p = await getKeywordHarvest({ market: 'all' })

console.log('── scope ──')
console.log(`  boundBy=${p.scope.boundBy} · market=${p.scope.market}`)
console.log(`  campaigns resolved ${p.scope.resolved.campaigns} of ${p.scope.resolved.campaignsInMarket} in market`)
console.log(`  🔴 campaigns WITH search-term data in this window: ${p.scope.resolved.campaignsWithTerms} · ad groups ${p.scope.resolved.adGroups}`)
console.log(`  ad-group picker options: ${p.scope.adGroupOptions.length}`)

console.log('\n── window + thresholds ──')
console.log(`  ${p.window.days} days · since ${p.window.since.slice(0, 10)} · minOrders ${p.thresholds.minOrders} · minSpend €${p.thresholds.minSpendEur}`)

console.log('\n── freshness (computed, never a constant) ──')
console.log(`  newest term date ${p.freshness.newestTermDate?.slice(0, 10)} · ${p.freshness.ageDays} day(s) old`)
console.log(`  newest row written at ${p.freshness.newestRowWrittenAt} · ${int(p.freshness.rows)} rows`)

console.log('\n── census ──')
const c = p.census
console.log(`  candidates ${c.candidates} — new ${c.new} · already-exact-here ${c.alreadyExactHere} · exact-elsewhere ${c.exactElsewhere} · local-only ${c.localOnly}`)
console.log(`  already negated somewhere: ${c.negatedAlready} of ${c.candidates}`)
console.log(`  🔴 every order from an EXACT match (tautological): ${c.exactMatchedOnly} of ${c.candidates}`)
console.log(`  at 1+ order: ${c.atOneOrder.candidates} candidates · ${c.atOneOrder.withoutKeywordInSource} with no exact keyword in source · ${c.atOneOrder.noExactMatch} never EXACT-matched`)
console.log(`              spend ${eur(c.atOneOrder.spendCents)} · sales ${eur(c.atOneOrder.salesCents)} · blended ACoS ${c.atOneOrder.acosPct?.toFixed(0)}%`)
console.log(`              ⚠️ ${c.atOneOrder.singleOrder} are single-order attributions; repeated sale values:`)
for (const r of c.atOneOrder.repeatedValues.slice(0, 6)) console.log(`                 ${eur(r.salesCents)} claimed by ${r.terms} terms`)
console.log(`  D4 — wasteful-term negatives (Negative Targeting owns these): ${c.negativeCandidates.count} · ${eur(c.negativeCandidates.spendCents)}`)
console.log(`  product candidates: ${c.productCandidates.graduations} graduations · ${c.productCandidates.negatives} negatives`)

console.log('\n── facets ──')
for (const [k, v] of Object.entries(p.facets)) console.log(`  ${pad(k, 14)} ${(v as Array<{ value: string; count: number }>).map((x) => `${x.value}=${x.count}`).join(' · ')}`)

console.log('\n── rows ──')
console.log(`${pad('term', 38)} ${pad('mkt', 4)} ${pad('ord', 4)} ${pad('clicks', 7)} ${pad('spend', 9)} ${pad('CPC', 7)} ${pad('ACoS', 6)} ${pad('status', 19)} ${pad('neg', 5)} ${pad('matched via', 24)} tgt`)
for (const r of p.rows) {
  console.log(
    `${pad(r.term, 38)} ${pad(r.market, 4)} ${pad(String(r.metrics.orders), 4)} ${pad(int(r.metrics.clicks), 7)} ${pad(eur(r.metrics.spendCents), 9)} ` +
    `${pad(r.metrics.cpcCents == null ? '—' : eur(r.metrics.cpcCents), 7)} ${pad(r.metrics.acosPct == null ? '—' : `${r.metrics.acosPct.toFixed(0)}%`, 6)} ` +
    `${pad(r.status, 19)} ${pad(r.negatedIn.rows === 0 ? '—' : `${r.negatedIn.rows}/${r.negatedIn.blocking}`, 5)} ` +
    `${pad(r.matchedVia.map((m) => `${m.matchType}=${m.orders}`).join(' '), 24)} ${r.campaign.targetingType ?? '?'}`,
  )
}
console.log(`\ntotal ${p.total} · truncated ${p.truncated}`)

// ── the blank-is-not-a-zero law, checked rather than asserted ────────────────
const zeroClick = p.rows.filter((r) => r.metrics.clicks === 0)
const zeroSales = p.rows.filter((r) => r.metrics.salesCents === 0)
console.log(`\n── law 1: a blank is not a zero ──`)
console.log(`  rows with 0 clicks: ${zeroClick.length} — all cpcCents null? ${zeroClick.every((r) => r.metrics.cpcCents === null)}`)
console.log(`  rows with 0 sales:  ${zeroSales.length} — all acosPct null?  ${zeroSales.every((r) => r.metrics.acosPct === null)}`)

// ── the four states are exhaustive and disjoint ──────────────────────────────
const sum = c.new + c.alreadyExactHere + c.exactElsewhere + c.localOnly
console.log(`\n── the four states partition the candidate set: ${c.new}+${c.alreadyExactHere}+${c.exactElsewhere}+${c.localOnly} = ${sum} (candidates ${c.candidates}) ${sum === c.candidates ? '✓' : '🔴 MISMATCH'}`)

// ── scope actually reaches the query ────────────────────────────────────────
console.log('\n\n═══ scope reaches the query — same read, narrowed ═══\n')
for (const m of ['IT', 'DE', 'ES', 'FR']) {
  const q = await getKeywordHarvest({ market: m })
  console.log(`  market=${m}: ${q.census.candidates} candidates · ${q.scope.resolved.campaignsWithTerms} campaigns with terms · boundBy=${q.scope.boundBy}`)
}
const withCamp = await getKeywordHarvest({ market: 'all' })
const firstCampId = withCamp.rows.find((r) => r.campaign.id)?.campaign.id
if (firstCampId) {
  const q = await getKeywordHarvest({ market: 'all', campaign: firstCampId })
  console.log(`  campaign=${withCamp.rows.find((r) => r.campaign.id === firstCampId)?.campaign.name}: ${q.census.candidates} candidates · boundBy=${q.scope.boundBy} · adGroup options ${q.scope.adGroupOptions.length}`)
  const agId = q.scope.adGroupOptions[0]?.id
  if (agId) {
    const q2 = await getKeywordHarvest({ market: 'all', campaign: firstCampId, adGroup: agId })
    console.log(`  + adGroup=${q.scope.adGroupOptions[0].name}: ${q2.census.candidates} candidates · boundBy=${q2.scope.boundBy}`)
  }
}
// a campaign from another market must resolve to NOTHING, not override the market picker
const itCamp = withCamp.rows.find((r) => r.market === 'IT' && r.campaign.id)?.campaign.id
if (itCamp) {
  const q = await getKeywordHarvest({ market: 'DE', campaign: itCamp })
  console.log(`  market=DE + an IT campaign: ${q.census.candidates} candidates (must be 0) ${q.census.candidates === 0 ? '✓' : '🔴'}`)
}

// ── the threshold is the whole argument ─────────────────────────────────────
console.log('\n\n═══ the threshold decides whether this tab has content ═══\n')
for (const n of [1, 2, 3]) {
  const q = await getKeywordHarvest({ market: 'all', minOrders: n })
  console.log(`  minOrders=${n}: ${q.census.candidates} candidates · new ${q.census.new} · already-exact-here ${q.census.alreadyExactHere} · exact-elsewhere ${q.census.exactElsewhere} · local-only ${q.census.localOnly}`)
}
for (const w of [30, 60, 90]) {
  const q = await getKeywordHarvest({ market: 'all', windowDays: w })
  console.log(`  window=${w}d: ${q.census.candidates} candidates · new ${q.census.new}`)
}

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
