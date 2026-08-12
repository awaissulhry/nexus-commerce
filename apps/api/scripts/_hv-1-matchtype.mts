/**
 * HV.1 — is "0 of 14 are new" a finding, or a tautology? READ-ONLY.
 *
 * `previewHarvest` has NO matchType filter — it groups every search-term row regardless of what
 * the term matched against. So a term that matched an EXACT keyword is offered as a candidate to
 * create that same EXACT keyword. If the 14 candidates are mostly EXACT-matched rows, then
 * "already exact here" is not a discovery about the account, it is the definition of the input.
 *
 * This decides how the page's headline sentence must be worded.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const since = new Date(Date.now() - 60 * 86_400_000)

console.log('\n═══ HV.1 — what did the candidates actually MATCH against? ═══\n')

// the same grouping previewHarvest does, but keeping matchType so the composition is visible
const rows = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'matchType'],
  where: { date: { gte: since } },
  _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true },
})

// re-aggregate to previewHarvest's grain (query × campaign × adGroup), carrying the match mix
type Agg = { orders: number; clicks: number; cost: number; byMatch: Map<string, number> }
const byGroup = new Map<string, Agg>()
for (const r of rows) {
  const k = `${r.query}|${r.campaignId}|${r.adGroupId}`
  const a = byGroup.get(k) ?? { orders: 0, clicks: 0, cost: 0, byMatch: new Map<string, number>() }
  const o = r._sum.orders7d ?? 0
  a.orders += o
  a.clicks += r._sum.clicks ?? 0
  a.cost += Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
  a.byMatch.set(String(r.matchType), (a.byMatch.get(String(r.matchType)) ?? 0) + o)
  byGroup.set(k, a)
}

const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())

for (const minOrders of [2, 1]) {
  const cands = [...byGroup.entries()]
    .filter(([k, a]) => a.orders >= minOrders && !isAsin(k.split('|')[0]))
    .sort((x, y) => y[1].orders - x[1].orders)

  console.log(`\n═══ minOrders ≥ ${minOrders} — ${cands.length} candidates ═══\n`)

  // the headline question: how many candidates got ALL their orders from an EXACT match?
  const allExact = cands.filter(([, a]) => (a.byMatch.get('EXACT') ?? 0) === a.orders && a.orders > 0)
  const someExact = cands.filter(([, a]) => (a.byMatch.get('EXACT') ?? 0) > 0)
  const noExact = cands.filter(([, a]) => (a.byMatch.get('EXACT') ?? 0) === 0)
  console.log(`  every order came from an EXACT match: ${allExact.length} of ${cands.length}`)
  console.log(`  at least one order from an EXACT match: ${someExact.length}`)
  console.log(`  no EXACT match at all (a genuine discovery): ${noExact.length}`)

  if (minOrders === 2) {
    console.log(`\n${pad('query', 40)} ${pad('ord', 4)} ${pad('spend', 9)} order attribution by matchType`)
    for (const [k, a] of cands) {
      const mix = [...a.byMatch.entries()].filter(([, n]) => n > 0).map(([m, n]) => `${m}=${n}`).join(' · ')
      console.log(`${pad(k.split('|')[0], 40)} ${pad(String(a.orders), 4)} ${pad(eur(a.cost), 9)} ${mix || '(no orders attributed to a match type)'}`)
    }
  } else {
    console.log(`\n  the ${noExact.length} candidates with no EXACT match — the real discovery set:`)
    console.log(`  ${pad('query', 44)} ${pad('ord', 4)} ${pad('spend', 9)} matchType`)
    for (const [k, a] of noExact.slice(0, 25)) {
      const mix = [...a.byMatch.entries()].filter(([, n]) => n > 0).map(([m, n]) => `${m}=${n}`).join(' · ')
      console.log(`  ${pad(k.split('|')[0], 44)} ${pad(String(a.orders), 4)} ${pad(eur(a.cost), 9)} ${mix}`)
    }
    if (noExact.length > 25) console.log(`  …and ${noExact.length - 25} more`)
  }
}

console.log('\n\n═══ the same question, over ALL search-term rows ═══\n')
const all = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['matchType'], where: { date: { gte: since } }, _count: true, _sum: { orders7d: true, costMicros: true },
})
console.log(`${pad('matchType', 36)} ${pad('rows', 8)} ${pad('orders', 8)} spend`)
for (const t of all.sort((a, b) => (b._sum.orders7d ?? 0) - (a._sum.orders7d ?? 0))) {
  console.log(`${pad(String(t.matchType), 36)} ${pad(int(t._count), 8)} ${pad(String(t._sum.orders7d ?? 0), 8)} ${eur(Math.round(Number(t._sum.costMicros ?? 0n) / 10000))}`)
}

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
