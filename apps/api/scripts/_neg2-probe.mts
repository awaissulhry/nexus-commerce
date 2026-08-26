/**
 * NEG.2 — establish the oracle before building anything. READ-ONLY.
 *
 * Two questions the whole section rests on:
 *
 *   1. `AmazonAdsSearchTerm.adGroupId` is an EXTERNAL Amazon id; `AdTarget` reaches its ad group
 *      through a LOCAL cuid. Joining the wrong pair yields `overlap = 0` for every term forever,
 *      and looks exactly like good news. `_neg-page-conflict.mts:44-84` is the oracle — this
 *      re-derives its answer independently and prints both, so the route can be checked against a
 *      number rather than against prose.
 *   2. Does `query` ever differ from `normaliseNegTerm(query)`? The oracle filters
 *      `query: { in: <normalised terms> }`, which silently drops any stored query that is not
 *      already lower-case and single-spaced. If that set is non-empty the route needs a different
 *      match, and the oracle itself is under-counting.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/ads-protect-converting.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.2 — the oracle, before the code ═══\n')

// ── 1 · is the stored query already normalised? ───────────────────────────────────────────────
h('1 · Does AmazonAdsSearchTerm.query ever differ from its normalised form?')
const since120 = new Date(Date.now() - 120 * 86400_000)
const distinct = await prisma.amazonAdsSearchTerm.findMany({
  where: { date: { gte: since120 } },
  select: { query: true },
  distinct: ['query'],
})
const dirty = distinct.filter((r) => normaliseNegTerm(r.query) !== r.query)
console.log(`distinct queries in 120d: ${int(distinct.length)}`)
console.log(`queries where normaliseNegTerm(q) !== q: ${int(dirty.length)}`)
for (const d of dirty.slice(0, 10)) console.log(`  ${JSON.stringify(d.query)} → ${JSON.stringify(normaliseNegTerm(d.query))}`)
if (dirty.length === 0) console.log('  → an exact `in` match on normalised keys is safe, and the oracle is not under-counting.')

// ── 2 · the negation base, keyed exactly as the oracle keys it ────────────────────────────────
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, negativeLevel: true, status: true,
    externalTargetId: true, createdAt: true,
    adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true } } } },
  },
})
const byTerm = new Map<string, typeof negs>()
for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }

h('2 · The four terms the route will be asserted against')
const TERMS = ['giacca moto', 'saponette moto', 'xavia']
// plus whichever term carries a CAMPAIGN-level negation, chosen from the data rather than assumed
const campTerm = [...byTerm.entries()].find(([, rows]) => rows.some((r) => r.negativeLevel === 'CAMPAIGN'))?.[0]
if (campTerm) TERMS.push(campTerm)

for (const term of TERMS) {
  const rows = byTerm.get(term) ?? []
  const adGroups = new Set(rows.filter((r) => r.negativeLevel !== 'CAMPAIGN').map((r) => r.adGroup?.externalAdGroupId).filter(Boolean))
  const campaigns = new Set(rows.map((r) => r.adGroup?.campaign?.id).filter(Boolean))
  const localAgs = new Set(rows.map((r) => r.adGroup?.id).filter(Boolean))

  // 30d, per (query, EXTERNAL adGroupId) — the oracle's grain
  const since30 = new Date(Date.now() - 30 * 86400_000)
  const perAg = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['adGroupId'],
    where: { date: { gte: since30 }, query: term },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const trafficAgs = new Set(perAg.map((r) => r.adGroupId))
  const overlapExternal = [...trafficAgs].filter((x) => adGroups.has(x))
  // 🔴 the wrong join, computed deliberately so the difference is a number rather than a warning
  const overlapWrongWay = [...trafficAgs].filter((x) => localAgs.has(x))

  const tot = perAg.reduce((a, r) => ({
    impr: a.impr + (r._sum.impressions ?? 0),
    clicks: a.clicks + (r._sum.clicks ?? 0),
    cost: a.cost + Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
    orders: a.orders + (r._sum.orders7d ?? 0),
    sales: a.sales + (r._sum.sales7dCents ?? 0),
  }), { impr: 0, clicks: 0, cost: 0, orders: 0, sales: 0 })

  const h120 = await prisma.amazonAdsSearchTerm.aggregate({
    where: { date: { gte: since120 }, query: term },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const liveCampaigns = rows.filter((r) => r.adGroup?.campaign?.status === 'ENABLED').length
  const atAmazon = rows.filter((r) => r.externalTargetId != null).length
  const campLevel = rows.filter((r) => r.negativeLevel === 'CAMPAIGN')

  console.log(`\n  「${term}」`)
  console.log(`    negations ${rows.length} · ad groups ${adGroups.size} · campaigns ${campaigns.size} · in a LIVE campaign ${liveCampaigns} · at Amazon ${atAmazon}`)
  console.log(`    30d: runsIn ${trafficAgs.size} ad groups · impr ${int(tot.impr)} · clicks ${int(tot.clicks)} · spend ${eur(tot.cost)} · orders ${tot.orders} · sales ${eur(tot.sales)}`)
  console.log(`    🔴 OVERLAP (external↔external) = ${overlapExternal.length}   ·   the WRONG join (external↔local) = ${overlapWrongWay.length}`)
  console.log(`    120d: impr ${int(h120._sum.impressions ?? 0)} · orders ${h120._sum.orders7d ?? 0} · sales ${eur(h120._sum.sales7dCents ?? 0)} · spend ${eur(Math.round(Number(h120._sum.costMicros ?? 0n) / 10000))}`)
  if (campLevel.length) console.log(`    CAMPAIGN-level rows: ${campLevel.length} · of those at Amazon: ${campLevel.filter((r) => r.externalTargetId != null).length}`)
}

// ── 3 · the protections, for the badge ────────────────────────────────────────────────────────
h('3 · Protections — which of these terms carries one, and under what semantics')
const prot = await prisma.adKeywordProtection.findMany({ select: { term: true, mode: true, matchType: true, isPrefix: true, marketplace: true, campaignId: true } })
console.log(`protections: ${prot.length} · ${prot.map((p) => `${p.term}(${p.matchType})`).join(' · ')}`)
for (const term of TERMS) {
  const hits = prot.filter((p) => {
    const t = p.term.toLowerCase()
    if (p.matchType === 'CONTAINS') return term.includes(t)
    if (p.matchType === 'PREFIX' || p.isPrefix) return term.startsWith(t)
    return term === t
  })
  console.log(`  ${term.padEnd(24)} ${hits.length ? hits.map((x) => `${x.mode} ${x.term} (${x.matchType})`).join(', ') : '—'}`)
}

await prisma.$disconnect()
