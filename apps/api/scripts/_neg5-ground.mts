/**
 * NEG.5 — the ground truth, before any audit code exists. READ-ONLY.
 *
 * The brief states 132 contradictions under CONTAINS, 32/96 under EXACT/PREFIX, and a 54/45/33
 * classification. Every one of those is re-derived here from the base, because the study that
 * produced them was written 2026-08-11 and `expressionType` is rewritten by an ingest as you read
 * it.
 *
 * 🔴 The classification is the part with no prior implementation. This script PRINTS the campaign
 * names behind each bucket so the rule that assigns them can be checked by eye rather than trusted.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { normaliseTerm } = await import('../src/services/advertising/ads-write-gate.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.5 — ground truth ═══\n')

// ── 0 · the two normalisers must agree, or the audit and the enforcement disagree silently ────
h('0 · normaliser identity')
const probes = ['  Giacca  MOTO Xavia ', 'AIR MESH', 'x-tuta\tuomo', '', 'XAVIA']
let normalisersAgree = true
for (const p of probes) {
  const a = normaliseNegTerm(p)
  const b = normaliseTerm(p)
  if (a !== b) { normalisersAgree = false; console.log(`  🔴 DIVERGE on ${JSON.stringify(p)}: neg=${JSON.stringify(a)} gate=${JSON.stringify(b)}`) }
}
console.log(`  ${normalisersAgree ? '✓' : '🔴'} normaliseNegTerm ≡ normaliseTerm over ${probes.length} probes`)

// ── 1 · the protections ───────────────────────────────────────────────────────────────────────
h('1 · the protections')
const protections = await prisma.adKeywordProtection.findMany({
  orderBy: [{ mode: 'asc' }, { term: 'asc' }],
})
console.log(`  rows ${int(protections.length)}`)
for (const p of protections) {
  const resolved = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
  console.log(`    ${p.mode.padEnd(9)} ${p.term.padEnd(12)} ${resolved.padEnd(9)} market=${p.marketplace ?? 'ALL'} campaign=${p.campaignId ?? 'ALL'} by=${p.createdBy ?? '—'} at=${p.createdAt.toISOString().slice(0, 10)} reason=${p.reason ?? '—'}`)
}
const whitelist = protections.filter((p) => p.mode === 'WHITELIST')
console.log(`  WHITELIST ${int(whitelist.length)} · BLACKLIST ${int(protections.length - whitelist.length)}`)
console.log(`  all CONTAINS: ${whitelist.every((p) => p.matchType === 'CONTAINS') ? 'yes' : '🔴 NO'}`)

// ── 2 · the base ──────────────────────────────────────────────────────────────────────────────
h('2 · the negation base')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, kind: true, status: true,
    externalTargetId: true, negativeLevel: true, createdAt: true,
    adGroup: {
      select: {
        id: true, name: true, externalAdGroupId: true,
        campaign: { select: { id: true, name: true, status: true, marketplace: true, portfolioId: true } },
      },
    },
  },
})
console.log(`  negatives ${int(negs.length)}`)

/** NEG.4 §5 verbatim — a negation BLOCKS only when all four hold. */
const isBlocking = (n: (typeof negs)[number]) =>
  n.externalTargetId != null
  && String(n.status) === 'ENABLED'
  && n.adGroup?.campaign?.status === 'ENABLED'
  && n.negativeLevel !== 'CAMPAIGN'
console.log(`  blocking ${int(negs.filter(isBlocking).length)}`)

// ── 3 · contradictions under all three semantics ──────────────────────────────────────────────
h('3 · contradictions — the three semantics')
const covers = (mode: string, negTerm: string, protTerm: string): boolean => {
  if (mode === 'CONTAINS') return negTerm.includes(protTerm)
  if (mode === 'PREFIX') return negTerm.startsWith(protTerm)
  return negTerm === protTerm
}
type Hit = { neg: (typeof negs)[number]; protTerm: string; negKey: string }
const under = (mode: 'CONTAINS' | 'PREFIX' | 'EXACT'): Hit[] => {
  const out: Hit[] = []
  for (const n of negs) {
    const key = normaliseNegTerm(n.expressionValue ?? '')
    if (!key) continue
    for (const p of whitelist) {
      const t = normaliseNegTerm(p.term)
      if (t && covers(mode, key, t)) { out.push({ neg: n, protTerm: p.term, negKey: key }); break }
    }
  }
  return out
}
const containsHits = under('CONTAINS')
const prefixHits = under('PREFIX')
const exactHits = under('EXACT')
console.log(`  CONTAINS ${int(containsHits.length)}   (brief: 132)`)
console.log(`  PREFIX   ${int(prefixHits.length)}   (brief: 96)`)
console.log(`  EXACT    ${int(exactHits.length)}   (brief: 32)`)
console.log(`  🔴 the LIVE semantics is CONTAINS — all ten rows carry it, so ${int(containsHits.length)} is the number that binds`)
console.log(`  of the ${int(containsHits.length)}, BLOCKING right now: ${int(containsHits.filter((x) => isBlocking(x.neg)).length)}`)

// ── 4 · by protected term ─────────────────────────────────────────────────────────────────────
h('4 · by protected term')
const byTerm = new Map<string, Hit[]>()
for (const x of containsHits) byTerm.set(x.protTerm, [...(byTerm.get(x.protTerm) ?? []), x])
for (const [t, hits] of [...byTerm].sort((a, b) => b[1].length - a[1].length)) {
  const ags = new Set(hits.map((x) => x.neg.adGroup?.id).filter(Boolean))
  const camps = new Set(hits.map((x) => x.neg.adGroup?.campaign?.id).filter(Boolean))
  console.log(`  ${t.padEnd(12)} ${String(hits.length).padStart(3)} negations · ${ags.size} ad groups · ${camps.size} campaigns · blocking ${hits.filter((x) => isBlocking(x.neg)).length}`)
}

// ── 5 · the classification — the part with no prior implementation ────────────────────────────
h('5 · classification inputs — campaign names, so the rule can be checked by eye')
const campNames = new Set(containsHits.map((x) => x.neg.adGroup?.campaign?.name ?? '—'))
console.log(`  distinct campaigns holding a contradiction: ${campNames.size}`)
for (const n of [...campNames].sort()) {
  const rows = containsHits.filter((x) => (x.neg.adGroup?.campaign?.name ?? '—') === n)
  const terms = [...new Set(rows.map((x) => x.protTerm))].sort()
  console.log(`    ${n}`)
  console.log(`      ${String(rows.length).padStart(3)} rows · protected terms hit: ${terms.join(', ')}`)
}

// ── 6 · xavia, named in the brief's assertion table ───────────────────────────────────────────
h('6 · xavia')
const xavia = containsHits.filter((x) => x.protTerm === 'xavia')
console.log(`  negations ${int(xavia.length)} · blocking ${int(xavia.filter((x) => isBlocking(x.neg)).length)}`)
for (const x of xavia) {
  console.log(`    "${x.negKey}" ${String(x.neg.expressionType)} ${String(x.neg.status)} ${x.neg.negativeLevel ?? 'AD_GROUP'} amazon=${x.neg.externalTargetId ? 'y' : 'n'} · ${x.neg.adGroup?.campaign?.name} › ${x.neg.adGroup?.name}`)
}

// ── 7 · reach — how many search-term queries contain each protected term ──────────────────────
h('7 · reach (last 30 days of search terms)')
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
const st = await prisma.amazonAdsSearchTerm.findMany({
  where: { date: { gte: since } },
  select: { query: true },
})
const queries = new Set(st.map((r) => normaliseNegTerm(r.query ?? '')).filter(Boolean))
console.log(`  distinct queries in window: ${int(queries.size)} (from ${int(st.length)} rows)`)
for (const p of whitelist) {
  const t = normaliseNegTerm(p.term)
  const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
  let n = 0
  for (const q of queries) if (covers(mode, q, t)) n++
  console.log(`    ${p.term.padEnd(12)} reaches ${String(n).padStart(4)} distinct queries`)
}

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
