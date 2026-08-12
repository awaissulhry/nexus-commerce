/**
 * NEG.6 — the ground truth for wasteful words, before any panel exists. READ-ONLY.
 *
 * Re-derives every number the brief states, and measures the four safety rails as PROPERTIES OF THE
 * DATA rather than as hypotheticals:
 *
 *   1. winning-gram collision — a wasteful gram that is a SUBSTRING of a winning gram
 *   2. converting terms behind a gram — what a phrase negation would actually kill
 *   3. protected-term collision — what `ads-write-gate.ts:304` would refuse
 *   4. the gram floor — how far down the tokenizer's own noise reaches
 *
 * 🔴 It also answers the §4 question with a measurement rather than an opinion: is the scope filter
 * cheap? `AmazonAdsSearchTerm` carries `marketplace`, `campaignId` and `adGroupId` — the last two
 * EXTERNAL — so the filter is a WHERE, and only campaign/ad-group scoping needs a local→external
 * map. Timings printed.
 */
import '../src/env.js'
const { analyzeNgrams } = await import('../src/services/advertising/ads-ngram.service.js')
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.6 — ground truth ═══\n')

const t0 = Date.now()
const ng = await analyzeNgrams({ windowDays: 60 })
console.log(`  analyzeNgrams(60d) took ${Date.now() - t0}ms`)

h('1 · counts')
console.log(`  wasteful ${int(ng.wasteful.length)} · winning ${int(ng.winning.length)} · window ${ng.windowDays}d`)

h('2 · top wasteful')
for (const r of ng.wasteful.slice(0, 12)) {
  console.log(`  ${r.gram.padEnd(24)} ${eur(r.costCents).padStart(9)} · ${String(r.clicks).padStart(4)} clicks · ${String(r.terms).padStart(4)} terms · ${r.n}g`)
}
h('2b · top winning')
for (const r of ng.winning.slice(0, 8)) {
  console.log(`  ${r.gram.padEnd(24)} ROAS ${(r.roas ?? 0).toFixed(1).padStart(6)} · ${eur(r.costCents).padStart(9)} · ${r.orders} orders`)
}

// ── 3 · already negated as a whole term ───────────────────────────────────────────────────────
h('3 · wasteful grams already negated as a WHOLE TERM')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: { expressionValue: true, status: true, externalTargetId: true },
})
const negTerms = new Set(negs.map((n) => normaliseNegTerm(n.expressionValue ?? '')).filter(Boolean))
const already = ng.wasteful.filter((r) => negTerms.has(normaliseNegTerm(r.gram)))
console.log(`  ${already.length} of ${ng.wasteful.length}: ${already.map((r) => r.gram).join(', ') || '—'}`)

// how many negated PHRASES contain each gram — a different question, and a different unit
h('3b · negated phrases CONTAINING each top gram (not the same as "already negated")')
for (const r of ng.wasteful.slice(0, 6)) {
  const g = normaliseNegTerm(r.gram)
  const containing = [...negTerms].filter((t) => t.includes(g)).length
  console.log(`  ${r.gram.padEnd(24)} appears inside ${String(containing).padStart(3)} negated phrases`)
}

// ── 4 · winning-gram collision ────────────────────────────────────────────────────────────────
h('4 · 🔴 wasteful grams that are a SUBSTRING of a winning gram')
const collisions: Array<{ waste: string; win: string; roas: number; wasteCost: number }> = []
for (const w of ng.wasteful) {
  const wg = normaliseNegTerm(w.gram)
  if (!wg) continue
  for (const win of ng.winning) {
    const winG = normaliseNegTerm(win.gram)
    if (winG !== wg && winG.includes(wg)) collisions.push({ waste: w.gram, win: win.gram, roas: win.roas ?? 0, wasteCost: w.costCents })
  }
}
console.log(`  ${collisions.length} collision(s):`)
for (const c of collisions) console.log(`    🔴 "${c.waste}" (${eur(c.wasteCost)}) ⊂ "${c.win}" (ROAS ${c.roas.toFixed(1)})`)

// ── 5 · converting terms a phrase negation would catch ────────────────────────────────────────
h('5 · converting terms behind the top wasteful grams (60d)')
const since = new Date(Date.now() - 60 * 86400_000)
const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: since } },
  _sum: { clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
const termRows = terms.map((t) => ({
  key: normaliseNegTerm(t.query ?? ''),
  clicks: t._sum.clicks ?? 0,
  cost: Math.round(Number(t._sum.costMicros ?? 0n) / 10000),
  orders: t._sum.orders7d ?? 0,
  sales: t._sum.sales7dCents ?? 0,
})).filter((t) => t.key)
console.log(`  search-term rows in window: ${int(termRows.length)}`)
for (const r of ng.wasteful.slice(0, 8)) {
  const g = normaliseNegTerm(r.gram)
  const caught = termRows.filter((t) => t.key.includes(g))
  const converting = caught.filter((t) => t.orders > 0)
  const sales = converting.reduce((a, t) => a + t.sales, 0)
  console.log(`  ${r.gram.padEnd(24)} catches ${String(caught.length).padStart(4)} terms · ${String(converting.length).padStart(2)} converting · ${eur(sales)} sales`)
}

// ── 6 · protected-term collision ──────────────────────────────────────────────────────────────
h('6 · protected-term collisions (what ads-write-gate.ts:304 would refuse)')
const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' } })
const blocked: string[] = []
for (const r of [...ng.wasteful, ...ng.winning]) {
  const g = normaliseNegTerm(r.gram)
  for (const p of prot) {
    const t = normaliseNegTerm(p.term)
    const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
    const hit = mode === 'CONTAINS' ? g.includes(t) : mode === 'PREFIX' ? g.startsWith(t) : g === t
    if (hit) blocked.push(`${r.gram} (protected by "${p.term}", ${mode})`)
  }
}
console.log(`  ${blocked.length}: ${blocked.join(' · ') || '—'}`)
const xavia = ng.winning.find((r) => r.gram === 'xavia')
console.log(`  xavia in WINNING list: ${xavia ? `yes, ROAS ${(xavia.roas ?? 0).toFixed(1)}` : '🔴 NO'}`)

// ── 7 · the gram floor ────────────────────────────────────────────────────────────────────────
h('7 · the gram floor — how short do actionable grams get?')
const short = ng.wasteful.filter((r) => r.gram.replace(/\s/g, '').length <= 3)
for (const r of short) console.log(`  "${r.gram}" len=${r.gram.length} ${eur(r.costCents)} · ${r.terms} terms`)
console.log(`  🔴 the tokenizer drops only words of length <= 1 (ads-ngram.service.ts:41), so 2-char noise survives`)
const lowTerm = ng.wasteful.filter((r) => r.terms < 5)
console.log(`  wasteful grams appearing in < 5 terms: ${lowTerm.length}${lowTerm.length ? ` (${lowTerm.map((r) => r.gram).join(', ')})` : ''}`)

// ── 8 · size tokens ───────────────────────────────────────────────────────────────────────────
h('8 · size-token grams (a catalogue gap, not waste)')
const SIZE = /^(\d)(xl|xs)$|^(xx+l)$|^(taglia|size|grande|gr)$/i
const sizes = ng.wasteful.filter((r) => r.gram.split(/\s+/).some((w) => SIZE.test(w)))
let sizeSpend = 0, sizeTerms = 0
for (const r of sizes) { sizeSpend += r.costCents; sizeTerms += r.terms; console.log(`  ${r.gram.padEnd(16)} ${eur(r.costCents).padStart(9)} · ${r.terms} terms`) }
console.log(`  total ${eur(sizeSpend)} across ${sizeTerms} term-appearances (grams OVERLAP — this is not a distinct-term count)`)

// ── 9 · §4 — is the scope filter cheap? ───────────────────────────────────────────────────────
h('9 · §4 — the scope filter, measured')
const markets = await prisma.amazonAdsSearchTerm.groupBy({ by: ['marketplace'], where: { date: { gte: since } }, _count: { _all: true } })
console.log(`  marketplaces present: ${markets.map((m) => `${m.marketplace}=${int(m._count._all)}`).join(' · ')}`)
const withExt = await prisma.campaign.count({ where: { externalCampaignId: { not: null } } })
const totalCamp = await prisma.campaign.count()
console.log(`  campaigns with externalCampaignId: ${int(withExt)} of ${int(totalCamp)} — a local→external map is available`)
const t1 = Date.now()
const it = await analyzeNgrams({ windowDays: 60, marketplace: 'IT' } as never)
console.log(`  analyzeNgrams({marketplace:'IT'}) took ${Date.now() - t1}ms → wasteful ${it.wasteful.length} winning ${it.winning.length}`)
console.log(`  🔴 if that equals the account-wide numbers, the option is NOT yet implemented (expected before the change)`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
