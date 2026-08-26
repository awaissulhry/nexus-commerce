/**
 * NEG page study — pass 2. READ-ONLY.
 *
 * Pass 1 crashed in section 7 (my bug: `r.q` inside the literal building `r`). This is that
 * section done properly, plus the four things pass 1 could not answer:
 *
 *   A  conflict detection at the AD GROUP grain — the trap that flipped twice in the tab study:
 *      "negated" ≠ "blocked". A term negated in 49 ad groups and running in 200 others is
 *      funnelled, not blocked. Only the OVERLAP is a conflict.
 *   B  the whitelist audit, classified by whether the protected term is the campaign's OWN line
 *      (indefensible) or a DIFFERENT line's (plausible cross-line routing).
 *   C  n-grams vs the negatives we already hold.
 *   D  the 62 ARCHIVED negatives — when, and is there any local record of who did it?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 76 - s.length))}`)
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

console.log('\n═══ NEG — page study, pass 2 ═══\n')

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionType: true, expressionValue: true, negativeLevel: true, status: true,
    externalTargetId: true, createdAt: true, updatedAt: true,
    adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true } } } },
  },
})
const byTerm = new Map<string, typeof negs>()
for (const n of negs) { const k = norm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }
console.log(`${int(negs.length)} negatives · ${int(byTerm.size)} distinct terms`)

// ── A. Conflict detection at the ad-group grain ───────────────────────────────
h('A · Conflict detection — the ad-group grain, 30d')
const since = new Date(Date.now() - 30 * 86400_000)
const terms = [...byTerm.keys()]

// per (query, adGroupId) so we can tell funnelled from blocked
const perAg = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'adGroupId'],
  where: { date: { gte: since }, query: { in: terms } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
console.log(`(query, adGroup) rows in 30d for a negated term: ${int(perAg.length)}`)

interface Agg { impr: number; clicks: number; cost: number; orders: number; sales: number }
const zero = (): Agg => ({ impr: 0, clicks: 0, cost: 0, orders: 0, sales: 0 })
const add = (a: Agg, r: typeof perAg[number]) => {
  a.impr += r._sum.impressions ?? 0
  a.clicks += r._sum.clicks ?? 0
  a.cost += Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
  a.orders += r._sum.orders7d ?? 0
  a.sales += r._sum.sales7dCents ?? 0
  return a
}

const termTotals = new Map<string, Agg>()
const termAgs = new Map<string, Set<string>>()          // external ad-group ids with traffic
for (const r of perAg) {
  const q = norm(r.query)
  termTotals.set(q, add(termTotals.get(q) ?? zero(), r))
  const s = termAgs.get(q) ?? new Set<string>(); s.add(r.adGroupId); termAgs.set(q, s)
}
// where each term is negated, by EXTERNAL ad-group id (and campaign, for CAMPAIGN-level rows)
const negAgs = new Map<string, Set<string>>()
const negCampaigns = new Map<string, Set<string>>()
for (const [t, rows] of byTerm) {
  const ags = new Set<string>(); const camps = new Set<string>()
  for (const r of rows) {
    if (r.negativeLevel === 'CAMPAIGN') { if (r.adGroup?.campaign?.externalCampaignId) camps.add(r.adGroup.campaign.externalCampaignId) }
    else if (r.adGroup?.externalAdGroupId) ags.add(r.adGroup.externalAdGroupId)
  }
  negAgs.set(t, ags); negCampaigns.set(t, camps)
}

const rowsOut = [...termTotals.entries()].map(([t, a]) => {
  const trafficAgs = termAgs.get(t) ?? new Set<string>()
  const blockedAgs = negAgs.get(t) ?? new Set<string>()
  const overlap = [...trafficAgs].filter((x) => blockedAgs.has(x)).length
  return { t, ...a, trafficAgs: trafficAgs.size, negAgs: blockedAgs.size, negCamps: (negCampaigns.get(t) ?? new Set()).size, overlap }
}).sort((a, b) => b.sales - a.sales)

const converting = rowsOut.filter((r) => r.orders > 0)
const clicksOnly = rowsOut.filter((r) => r.orders === 0 && r.clicks > 0)
const silent = terms.filter((t) => !termTotals.has(t))
console.log(`\nnegated terms with ANY traffic in 30d: ${int(rowsOut.length)} of ${int(terms.length)}`)
console.log(`  converting (orders>0): ${int(converting.length)}`)
console.log(`  clicks but no orders:  ${int(clicksOnly.length)}   ← these are the negatives WORKING`)
console.log(`  no traffic at all:     ${int(silent.length)}`)
console.log(`\nsales on negated-but-still-converting terms, 30d: ${eur(converting.reduce((s, r) => s + r.sales, 0))} on ${eur(converting.reduce((s, r) => s + r.cost, 0))} spend`)
console.log(`\n⚠ "negIn" is where it is negated; "runsIn" is where it took impressions; OVERLAP=0 means`)
console.log(`  the negative is routing traffic, not blocking it. Only overlap>0 is a live conflict.\n`)
console.log(`${pad('term', 38)} ${pad('negIn', 6)} ${pad('runsIn', 7)} ${pad('overlap', 8)} ${pad('impr', 8)} ${pad('ord', 5)} ${pad('sales', 10)} acos`)
for (const r of converting.slice(0, 25)) {
  const acos = r.sales > 0 ? `${((r.cost / r.sales) * 100).toFixed(0)}%` : '—'
  console.log(`${pad(r.t, 38)} ${pad(String(r.negAgs) + (r.negCamps ? `+${r.negCamps}c` : ''), 6)} ${pad(String(r.trafficAgs), 7)} ${pad(String(r.overlap), 8)} ${pad(int(r.impr), 8)} ${pad(String(r.orders), 5)} ${pad(eur(r.sales), 10)} ${acos}`)
}
const realConflicts = converting.filter((r) => r.overlap > 0)
console.log(`\n🔴 converting terms whose traffic ad group is ALSO a negating ad group: ${int(realConflicts.length)}`)
for (const r of realConflicts) console.log(`   ${pad(r.t, 38)} overlap=${r.overlap} of ${r.trafficAgs} · ${r.orders} orders · ${eur(r.sales)}`)

// the dark ones: negated and no traffic anywhere — with historic evidence
h('A2 · negated + zero traffic in 30d, but earned in the 120d before that')
const since120 = new Date(Date.now() - 120 * 86400_000)
const hist = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: since120 }, query: { in: silent } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
const darkEarners = hist.map((r) => ({
  t: norm(r.query),
  impr: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0,
  cost: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
  orders: r._sum.orders7d ?? 0, sales: r._sum.sales7dCents ?? 0,
})).filter((r) => r.orders > 0).sort((a, b) => b.sales - a.sales)
console.log(`terms with 0 traffic in 30d but ≥1 order in 120d: ${int(darkEarners.length)}`)
for (const d of darkEarners) {
  const rows = byTerm.get(d.t) ?? []
  const live = rows.filter((r) => r.adGroup?.campaign?.status === 'ENABLED').length
  const acos = d.sales > 0 ? `${((d.cost / d.sales) * 100).toFixed(0)}%` : '—'
  console.log(`  ${pad(d.t, 38)} negIn=${pad(String(rows.length), 4)} (${live} in LIVE campaigns) orders=${d.orders} sales=${pad(eur(d.sales), 10)} acos=${acos}`)
}

// ── B. Whitelist audit, classified by line ownership ──────────────────────────
h('B · Whitelist contradictions — is the protected term the campaign’s OWN line?')
const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' } })
type Row = { term: string; prot: string; camp: string; ag: string; mkt: string; ownLine: boolean; brandCamp: boolean }
const hits: Row[] = []
for (const n of negs) {
  const t = norm(n.expressionValue)
  for (const p of prot) {
    const pt = norm(p.term)
    if (!t.includes(pt)) continue
    const camp = n.adGroup?.campaign?.name ?? '?'
    hits.push({
      term: n.expressionValue, prot: p.term, camp, ag: n.adGroup?.name ?? '?',
      mkt: n.adGroup?.campaign?.marketplace ?? '?',
      ownLine: norm(camp).includes(pt.replace(/\s+/g, '')) || norm(camp).includes(pt),
      brandCamp: /brand/i.test(camp),
    })
  }
}
console.log(`CONTAINS hits: ${int(hits.length)}`)
const ownBrand = hits.filter((x) => x.ownLine && x.brandCamp)
const otherBrand = hits.filter((x) => !x.ownLine && x.brandCamp)
const nonBrand = hits.filter((x) => !x.brandCamp)
console.log(`  the term IS the campaign's own line, in a BRAND campaign → ${int(ownBrand.length)}  🔴 indefensible`)
console.log(`  a DIFFERENT line's term, in a brand campaign            → ${int(otherBrand.length)}  ⚠ plausible cross-line routing`)
console.log(`  not a brand campaign at all (auto/category/generic)     → ${int(nonBrand.length)}  ✓ standard funnel`)
console.log(`\nthe indefensible set, in full:`)
for (const x of ownBrand) console.log(`  "${pad(x.term, 26)}" ⊃ ${pad(x.prot, 9)} ${pad(x.mkt, 3)} ${x.camp}  ‹${x.ag}›`)
console.log(`\nsample of the cross-line set:`)
for (const x of otherBrand.slice(0, 12)) console.log(`  "${pad(x.term, 26)}" ⊃ ${pad(x.prot, 9)} ${pad(x.mkt, 3)} ${x.camp}`)
console.log(`\nsample of the non-brand set:`)
for (const x of nonBrand.slice(0, 12)) console.log(`  "${pad(x.term, 26)}" ⊃ ${pad(x.prot, 9)} ${pad(x.mkt, 3)} ${x.camp}`)

// ── C. n-grams ────────────────────────────────────────────────────────────────
h('C · n-grams vs the negatives we hold')
const { analyzeNgrams } = await import('../src/services/advertising/ads-ngram.service.js')
const ng = await analyzeNgrams({ windowDays: 60 })
console.log(`window ${ng.windowDays}d · wasteful grams: ${ng.wasteful.length} · winning: ${ng.winning.length}`)
const negSet = new Set(terms)
console.log(`\n${pad('gram', 32)} ${pad('n', 2)} ${pad('spend', 10)} ${pad('clicks', 7)} ${pad('terms', 6)} ${pad('negatedExactly', 15)} inNegatedPhrases`)
for (const g of ng.wasteful.slice(0, 25)) {
  const contained = terms.filter((t) => t.includes(g.gram)).length
  console.log(`${pad(g.gram, 32)} ${pad(String(g.n), 2)} ${pad(eur(g.costCents), 10)} ${pad(int(g.clicks), 7)} ${pad(int(g.terms), 6)} ${pad(negSet.has(g.gram) ? 'YES' : 'no', 15)} ${contained}`)
}
const coveredExactly = ng.wasteful.filter((g) => negSet.has(g.gram)).length
console.log(`\nof the top ${ng.wasteful.length} wasteful grams, already negated as a whole term: ${coveredExactly}`)
console.log(`top-10 wasteful-gram spend (60d): ${eur(ng.wasteful.slice(0, 10).reduce((s, g) => s + g.costCents, 0))} — grams overlap, so this is an upper bound`)
console.log(`\ntop 10 WINNING grams (what a negation must never touch):`)
for (const g of ng.winning.slice(0, 10)) console.log(`  ${pad(g.gram, 32)} roas=${(g.roas ?? 0).toFixed(1)} sales=${pad(eur(g.salesCents), 11)} spend=${eur(g.costCents)}`)

// ── D. The 62 archived negatives ──────────────────────────────────────────────
h('D · The 62 ARCHIVED negatives — when, where, and by what')
const arch = negs.filter((n) => n.status === 'ARCHIVED')
const campsOf = new Map<string, number>()
for (const a of arch) campsOf.set(a.adGroup?.campaign?.name ?? '?', (campsOf.get(a.adGroup?.campaign?.name ?? '?') ?? 0) + 1)
console.log(`archived: ${arch.length} across ${campsOf.size} campaign(s): ${[...campsOf].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const days = new Map<string, number>()
for (const a of arch) { const d = a.updatedAt.toISOString().slice(0, 10); days.set(d, (days.get(d) ?? 0) + 1) }
console.log(`updatedAt days: ${[...days].sort().map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const created = new Map<string, number>()
for (const a of arch) { const d = a.createdAt.toISOString().slice(0, 10); created.set(d, (created.get(d) ?? 0) + 1) }
console.log(`createdAt days: ${[...created].sort().map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const archIds = arch.map((a) => a.id)
const archLogs = await prisma.advertisingActionLog.count({ where: { entityId: { in: archIds } } })
console.log(`AdvertisingActionLog rows referencing any of them: ${archLogs}`)
// OutboundSyncQueue keys the entity inside `payload`, not as columns.
const qRows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT COUNT(*)::bigint AS n FROM "OutboundSyncQueue"
   WHERE payload->>'entityType' = 'AD_TARGET' AND payload->>'entityId' = ANY($1::text[])`,
  archIds,
)
console.log(`OutboundSyncQueue rows for them (i.e. Nexus pushed a change): ${Number(qRows[0]?.n ?? 0)}`)
const campRow = await prisma.campaign.findFirst({
  where: { adGroups: { some: { targets: { some: { id: archIds[0] } } } } },
  select: { name: true, status: true, updatedAt: true, externalCampaignId: true },
})
console.log(`the campaign they sit in: "${campRow?.name}" status=${campRow?.status} updated=${campRow?.updatedAt.toISOString().slice(0, 16)}`)
// every AD_TARGET in that campaign, negative or not — is the whole campaign archived?
const sib = await prisma.adTarget.groupBy({
  by: ['status', 'isNegative'],
  where: { adGroup: { campaign: { name: campRow?.name ?? '—' } } },
  _count: { _all: true },
})
console.log(`all targets in that campaign: ${sib.map((s) => `${s.status}/${s.isNegative ? 'neg' : 'pos'}=${s._count._all}`).join(' · ')}`)

// ── E. the base by creation day, and the 2026-05-20 import ────────────────────
h('E · Creation cohorts')
const cohort = new Map<string, number>()
for (const n of negs) { const d = n.createdAt.toISOString().slice(0, 10); cohort.set(d, (cohort.get(d) ?? 0) + 1) }
for (const [d, c] of [...cohort].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${d}  ${int(c)}`)
console.log(`distinct creation days: ${cohort.size}`)

// ── F. proposal queue ─────────────────────────────────────────────────────────
h('F · The proposal queue')
const sugg = await prisma.adsRuleSuggestion.findMany({ select: { status: true, actionType: true, createdAt: true }, take: 3000, orderBy: { createdAt: 'desc' } })
const t2 = (rows: typeof sugg, f: (r: typeof sugg[number]) => string) => {
  const m = new Map<string, number>(); for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}
console.log(`rows: ${int(sugg.length)}`)
console.log(`status:     ${t2(sugg, (s) => String(s.status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`actionType: ${t2(sugg, (s) => String(s.actionType ?? '—')).slice(0, 12).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const negSugg = sugg.filter((s) => /negat|harvest/i.test(String(s.actionType ?? '')))
console.log(`negation/harvest: ${int(negSugg.length)} — ${t2(negSugg, (s) => String(s.status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
if (negSugg.length) console.log(`  oldest: ${negSugg[negSugg.length - 1]!.createdAt.toISOString().slice(0, 10)} · newest: ${negSugg[0]!.createdAt.toISOString().slice(0, 10)}`)

console.log('\n═══ done — read-only, nothing changed ═══\n')
await prisma.$disconnect()
