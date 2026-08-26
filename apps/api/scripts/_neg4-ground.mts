/**
 * NEG.4 — the ground truth, before any detector exists. READ-ONLY.
 *
 * 🔴 The correct answer for Detector A is ZERO, which is exactly what a broken join also returns.
 * So this script computes the overlap FOUR ways and prints all four, and the differences between
 * them are the evidence that the zero is real:
 *
 *   1. relaxed  · external↔external · ANY negation state   → expect 1 (`saponette moto`)
 *   2. relaxed  · external↔LOCAL    · the broken join      → expect 0 for every term
 *   3. blocking · external↔external · §5's full predicate  → expect 0 — the policy filter
 *   4. per-state breakdown of the one overlapping negation, so the 1→0 collapse has a reason
 *      on the record rather than being asserted.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
const WINDOW = 30
const HISTORY = 120

console.log('\n═══ NEG.4 — ground truth ═══\n')

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, kind: true, status: true,
    externalTargetId: true, negativeLevel: true, createdAt: true,
    adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, status: true, marketplace: true, liveBidWritesEnabled: true } } } },
  },
})
h('1 · The base')
console.log(`  negatives ${int(negs.length)}`)
console.log(`  no Amazon id ${int(negs.filter((n) => !n.externalTargetId).length)} · ARCHIVED ${int(negs.filter((n) => String(n.status) === 'ARCHIVED').length)} · campaign-level ${int(negs.filter((n) => n.negativeLevel === 'CAMPAIGN').length)}`)

/** §5 — a negation BLOCKS only when all four hold. */
const isBlocking = (n: typeof negs[number]) =>
  n.externalTargetId != null
  && String(n.status) === 'ENABLED'
  && n.adGroup?.campaign?.status === 'ENABLED'
  && n.negativeLevel !== 'CAMPAIGN'
const blocking = negs.filter(isBlocking)
console.log(`  🔴 BLOCKING (the denominator Detector A reports against): ${int(blocking.length)}`)

const byTerm = new Map<string, typeof negs>()
for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }
console.log(`  distinct terms ${int(byTerm.size)}`)

// ── traffic, at the (query, EXTERNAL adGroupId) grain — the oracle's own query ────────────────
const since = new Date(Date.now() - WINDOW * 86400_000)
const terms = [...byTerm.keys()]
const perAg = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'adGroupId'],
  where: { date: { gte: since }, query: { in: terms } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
h('2 · Traffic')
console.log(`  (query, adGroup) rows in ${WINDOW}d for a negated term: ${int(perAg.length)}`)
if (perAg.length === 0) console.log('  🔴 ZERO — that is not a clean account, that is a failed read. STOP.')

const trafficByTerm = new Map<string, Map<string, { impr: number; clicks: number; cost: number; orders: number; sales: number }>>()
for (const r of perAg) {
  const t = normaliseNegTerm(r.query)
  const m = trafficByTerm.get(t) ?? new Map()
  m.set(r.adGroupId, {
    impr: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0,
    cost: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
    orders: r._sum.orders7d ?? 0, sales: r._sum.sales7dCents ?? 0,
  })
  trafficByTerm.set(t, m)
}

// ── the four overlaps ─────────────────────────────────────────────────────────────────────────
h('3 · 🔴 The overlap, computed FOUR ways')
let relaxedExt = 0, relaxedLocal = 0, blockingExt = 0
const relaxedHits: Array<{ term: string; ag: string }> = []
const blockingHits: Array<{ term: string; ag: string }> = []
for (const [term, rows] of byTerm) {
  const traffic = trafficByTerm.get(term)
  if (!traffic) continue
  // 1 · relaxed, external↔external — ANY negation state, ad-group scope only
  const relaxedExtIds = new Set(rows.filter((r) => r.negativeLevel !== 'CAMPAIGN').map((r) => r.adGroup?.externalAdGroupId).filter((x): x is string => !!x))
  for (const ag of traffic.keys()) if (relaxedExtIds.has(ag)) { relaxedExt++; relaxedHits.push({ term, ag }) }
  // 2 · the BROKEN join — external traffic id against our LOCAL cuid
  const localIds = new Set(rows.map((r) => r.adGroup?.id).filter((x): x is string => !!x))
  for (const ag of traffic.keys()) if (localIds.has(ag)) relaxedLocal++
  // 3 · blocking only — §5's predicate
  const blockingExtIds = new Set(rows.filter(isBlocking).map((r) => r.adGroup?.externalAdGroupId).filter((x): x is string => !!x))
  for (const ag of traffic.keys()) if (blockingExtIds.has(ag)) { blockingExt++; blockingHits.push({ term, ag }) }
}
console.log(`  1 · relaxed, external↔external (any state)  = ${relaxedExt}   ← the JOIN test; must be 1`)
console.log(`  2 · relaxed, external↔LOCAL   (broken join) = ${relaxedLocal}   ← must be 0, and differ from (1)`)
console.log(`  3 · blocking only, external↔external        = ${blockingExt}   ← Detector A; expected 0`)
for (const hit of relaxedHits) console.log(`      relaxed hit: 「${hit.term}」 ad group ${hit.ag}`)
for (const hit of blockingHits) console.log(`      BLOCKING hit: 「${hit.term}」 ad group ${hit.ag}`)

h('4 · Why the 1 collapses to 0 — the overlapping negations, by state')
for (const hit of relaxedHits) {
  const rows = (byTerm.get(hit.term) ?? []).filter((r) => r.adGroup?.externalAdGroupId === hit.ag)
  console.log(`  「${hit.term}」 in ad group ${hit.ag} — ${rows.length} negation row(s):`)
  for (const r of rows) {
    console.log(`    ${r.expressionType.padEnd(15)} status=${String(r.status).padEnd(9)} campaign="${r.adGroup?.campaign?.name}" (${r.adGroup?.campaign?.status}) atAmazon=${r.externalTargetId ? 'yes' : 'NO'} → blocking=${isBlocking(r)}`)
  }
  const tr = trafficByTerm.get(hit.term)?.get(hit.ag)
  console.log(`    that ad group's own traffic: ${int(tr?.impr ?? 0)} impr · ${tr?.orders ?? 0} orders · ${eur(tr?.sales ?? 0)}`)
}

// ── Detector B ────────────────────────────────────────────────────────────────────────────────
h('5 · Detector B — suppressed earners')
const since120 = new Date(Date.now() - HISTORY * 86400_000)
const hist = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'], where: { date: { gte: since120 }, query: { in: terms } },
  _sum: { impressions: true, orders7d: true, sales7dCents: true, costMicros: true },
})
const histByTerm = new Map(hist.map((r) => [normaliseNegTerm(r.query), {
  impr: r._sum.impressions ?? 0, orders: r._sum.orders7d ?? 0,
  sales: r._sum.sales7dCents ?? 0, cost: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
}]))
const windowImpr = (t: string) => [...(trafficByTerm.get(t)?.values() ?? [])].reduce((a, x) => a + x.impr, 0)

const candidates: Array<{ term: string; negations: number; blocking: number; orders: number; sales: number; cost: number }> = []
for (const [term, rows] of byTerm) {
  if (windowImpr(term) !== 0) continue
  const hb = histByTerm.get(term)
  if (!hb || hb.orders < 1) continue
  candidates.push({ term, negations: rows.length, blocking: rows.filter(isBlocking).length, orders: hb.orders, sales: hb.sales, cost: hb.cost })
}
candidates.sort((a, b) => b.sales - a.sales)
console.log(`  terms with 0 impressions in ${WINDOW}d and ≥1 order in ${HISTORY}d: ${candidates.length}`)
for (const c of candidates) {
  const verdict = c.blocking > 0 ? '🔴 FINDING' : '✓ explained — nothing is blocking it; the campaigns are paused'
  console.log(`    ${c.term.padEnd(32)} negations=${String(c.negations).padStart(2)} blocking=${String(c.blocking).padStart(2)} orders=${c.orders} sales=${eur(c.sales)} spend=${eur(c.cost)}  ${verdict}`)
}
console.log(`  → findings ${candidates.filter((c) => c.blocking > 0).length} · explained ${candidates.filter((c) => c.blocking === 0).length}`)

// ── split-brain ───────────────────────────────────────────────────────────────────────────────
h('6 · Split-brain')
const split = negs.filter((n) => !n.externalTargetId)
console.log(`  negations with no Amazon id: ${int(split.length)}`)
console.log(`    campaign-scope mirrors (the marketplace-not-passed defect): ${int(split.filter((n) => n.negativeLevel === 'CAMPAIGN').length)}`)
console.log(`    ad-group rows that never got an id back:                   ${int(split.filter((n) => n.negativeLevel !== 'CAMPAIGN').length)}`)
console.log(`    of those, in an allowlisted campaign (removable today):    ${int(split.filter((n) => n.adGroup?.campaign?.liveBidWritesEnabled).length)}`)

h('7 · Actionability — how much of each list can be acted on')
const allow = (n: typeof negs[number]) => n.adGroup?.campaign?.liveBidWritesEnabled === true
console.log(`  blocking negations in an allowlisted campaign: ${int(blocking.filter(allow).length)} of ${int(blocking.length)}`)
console.log(`  split-brain rows are LOCAL deletes — the gate never runs, so all ${int(split.length)} are actionable`)

await prisma.$disconnect()
