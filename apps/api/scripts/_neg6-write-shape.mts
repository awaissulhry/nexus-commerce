/**
 * NEG.6 — what a gram negation would actually touch. READ-ONLY, no Amazon call.
 *
 * Three questions the brief leaves open, each of which decides UI copy:
 *
 *   1. TOKEN vs SUBSTRING. Amazon's negative PHRASE match blocks a contiguous token sequence.
 *      `includes()` is a SUPERSET of that — it also matches inside words. Which number goes on the
 *      row changes what "195 terms" means, so both are measured and the difference is reported.
 *   2. Ad-group reach. A gram lives in N ad groups; the write is one call per ad group. How many,
 *      and how many of those are on the live-write allowlist (`Campaign.liveBidWritesEnabled`)?
 *   3. 🔴 The converting-term check is near-tautological for a wasteful gram — "wasteful" is
 *      DEFINED as aggregate orders = 0, so no token-matched term can have converted. It can only
 *      ever fire on substring-but-not-token matches. That is a property of the definition, not
 *      evidence the check works, and the panel must not present a structural zero as a safety pass.
 */
import '../src/env.js'
const { analyzeNgrams } = await import('../src/services/advertising/ads-ngram.service.js')
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

/** Amazon negative-phrase semantics: the gram's tokens appear as a contiguous run. */
function tokenPhraseMatch(query: string, gram: string): boolean {
  const q = normaliseNegTerm(query).split(' ').filter(Boolean)
  const g = normaliseNegTerm(gram).split(' ').filter(Boolean)
  if (!g.length || g.length > q.length) return false
  for (let i = 0; i + g.length <= q.length; i++) {
    let ok = true
    for (let j = 0; j < g.length; j++) if (q[i + j] !== g[j]) { ok = false; break }
    if (ok) return true
  }
  return false
}

console.log('\n═══ NEG.6 — the shape of the write ═══\n')

const ng = await analyzeNgrams({ windowDays: 60 })
const since = new Date(Date.now() - 60 * 86400_000)

const st = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'adGroupId', 'campaignId', 'marketplace'],
  where: { date: { gte: since } },
  _sum: { clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
console.log(`  (query × ad group) rows in window: ${int(st.length)}`)

const campaigns = await prisma.campaign.findMany({
  where: { externalCampaignId: { not: null } },
  select: { id: true, name: true, externalCampaignId: true, status: true, liveBidWritesEnabled: true, marketplace: true },
})
const byExt = new Map(campaigns.map((c) => [c.externalCampaignId as string, c]))

h('1 · TOKEN vs SUBSTRING — the two readings of "N terms"')
const queries = [...new Set(st.map((r) => r.query))]
for (const g of ng.wasteful.slice(0, 8)) {
  const key = normaliseNegTerm(g.gram)
  const sub = queries.filter((q) => normaliseNegTerm(q).includes(key)).length
  const tok = queries.filter((q) => tokenPhraseMatch(q, g.gram)).length
  const flag = sub !== tok ? `  🔴 differ by ${sub - tok}` : ''
  console.log(`  ${g.gram.padEnd(22)} substring ${String(sub).padStart(4)} · token ${String(tok).padStart(4)} · gram.terms ${String(g.terms).padStart(4)}${flag}`)
}

h('2 · ad-group reach + the write allowlist')
for (const g of ng.wasteful.slice(0, 6)) {
  const hits = st.filter((r) => tokenPhraseMatch(r.query, g.gram))
  const ags = new Map<string, string>()
  for (const r of hits) ags.set(r.adGroupId, r.campaignId)
  let allow = 0, deny = 0
  const denyNames = new Set<string>()
  for (const [, cid] of ags) {
    const c = byExt.get(cid)
    if (c?.liveBidWritesEnabled) allow++
    else { deny++; if (c) denyNames.add(c.name) }
  }
  console.log(`  ${g.gram.padEnd(22)} ${String(ags.size).padStart(3)} ad groups · allowlisted ${String(allow).padStart(3)} · refused ${String(deny).padStart(3)}`)
}

h('3 · 🔴 the converting-term check is structurally near-empty for a wasteful gram')
for (const g of ng.wasteful.slice(0, 6)) {
  const hits = st.filter((r) => tokenPhraseMatch(r.query, g.gram))
  const orders = hits.reduce((a, r) => a + (r._sum.orders7d ?? 0), 0)
  const subHits = st.filter((r) => normaliseNegTerm(r.query).includes(normaliseNegTerm(g.gram)))
  const subOrders = subHits.reduce((a, r) => a + (r._sum.orders7d ?? 0), 0)
  console.log(`  ${g.gram.padEnd(22)} token-matched orders ${orders} · substring-matched orders ${subOrders}`)
}
console.log(`  "wasteful" IS orders === 0, so a token-matched converting term cannot exist by construction.`)
console.log(`  The check therefore proves nothing on its own — the TERM COUNT is what proves the join ran.`)

h('4 · existing negatives that already cover a gram, per ad group')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: { expressionValue: true, status: true, externalTargetId: true, adGroup: { select: { externalAdGroupId: true } } },
})
for (const g of ng.wasteful.slice(0, 6)) {
  const key = normaliseNegTerm(g.gram)
  const exact = negs.filter((n) => normaliseNegTerm(n.expressionValue ?? '') === key)
  console.log(`  ${g.gram.padEnd(22)} already negated in ${String(exact.length).padStart(3)} ad groups (as the whole phrase)`)
}

h('5 · the market split — does a gram concentrate in one marketplace?')
for (const g of ng.wasteful.slice(0, 6)) {
  const hits = st.filter((r) => tokenPhraseMatch(r.query, g.gram))
  const m = new Map<string, number>()
  for (const r of hits) m.set(r.marketplace, (m.get(r.marketplace) ?? 0) + Math.round(Number(r._sum.costMicros ?? 0n) / 10000))
  console.log(`  ${g.gram.padEnd(22)} ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${eur(v)}`).join(' · ')}`)
}

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
