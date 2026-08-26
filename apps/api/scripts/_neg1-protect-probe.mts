/**
 * NEG.0(a) — does the protection actually bind, and what does it cost? READ-ONLY.
 *
 * Runs the real `convertedTermsIn` against production and answers three things the fix is worthless
 * without: how long the one read takes, how many terms it protects, and — the load-bearing one —
 * how many of the 2,059 negatives already in the account would have been refused had this branch
 * existed when they were written.
 */
import '../src/env.js'
const { convertedTermsIn, decideNegation, normaliseNegTerm } = await import('../src/services/advertising/ads-protect-converting.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 76 - s.length))}`)

console.log('\n═══ NEG.0(a) — protectConverting, measured ═══\n')

h('1 · The one read — cost and size')
for (const days of [30, 60, 120]) {
  const t = Date.now()
  const m = await convertedTermsIn(days)
  const orders = [...m.values()].reduce((a, b) => a + b.orders, 0)
  const sales = [...m.values()].reduce((a, b) => a + b.salesCents, 0)
  console.log(`  ${String(days).padStart(3)}d → ${String(int(m.size)).padStart(6)} protected terms · ${int(orders)} orders · €${(sales / 100).toFixed(2)} · ${Date.now() - t}ms`)
}

const converted = await convertedTermsIn(30)
const config = { enabled: true, days: 30 }

h('2 · 🔴 How much of the existing base would this branch have refused?')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: { expressionValue: true, status: true, externalTargetId: true, adGroup: { select: { campaign: { select: { status: true, marketplace: true } } } } },
})
const refusedRows = negs.filter((n) => !decideNegation({ term: n.expressionValue, config, converted }).allowed)
const refusedTerms = new Set(refusedRows.map((n) => normaliseNegTerm(n.expressionValue)))
console.log(`negatives that would be refused today: ${int(refusedRows.length)} of ${int(negs.length)} rows, over ${int(refusedTerms.size)} distinct terms`)
const live = refusedRows.filter((n) => n.status === 'ENABLED' && n.adGroup?.campaign?.status === 'ENABLED' && n.externalTargetId != null)
console.log(`  of which are blocking right now (target+campaign ENABLED, confirmed at Amazon): ${int(live.length)}`)

h('3 · The refused terms, with the evidence a refusal would carry')
const rows = [...refusedTerms]
  .map((t) => ({ t, c: converted.get(t)!, n: refusedRows.filter((r) => normaliseNegTerm(r.expressionValue) === t).length }))
  .sort((a, b) => b.c.salesCents - a.c.salesCents)
for (const r of rows.slice(0, 20)) {
  console.log(`  ${r.t.padEnd(38)} ${String(r.c.orders).padStart(3)} orders · €${(r.c.salesCents / 100).toFixed(2).padStart(9)} · ${r.c.markets.join(',').padEnd(11)} · negated in ${r.n} rows`)
}

h('4 · The one that matters — does it protect the terms the study named?')
// The five suppressed earners from the page study §6, Detector B. A protection that does not catch
// these is not the protection the builder promised.
for (const t of ['xavia', 'chaqueta moto verano hombre', 'giacca pelle moto', 'giacca moto', 'saponette moto']) {
  const d = decideNegation({ term: t, config, converted })
  console.log(`  ${t.padEnd(30)} ${d.allowed ? 'ALLOWED — no order in 30d' : 'REFUSED'}${d.evidence ? ` (${d.evidence.orders} orders, €${(d.evidence.salesCents / 100).toFixed(2)})` : ''}`)
}
// Detector B's window is 120d and the toggle's default is 30d, so a term that earned four months
// ago is NOT protected by the default. That is the toggle's own promise, not a defect — but it is
// the difference between "protected" and "protected under this rule's setting", and worth stating.
const c120 = await convertedTermsIn(120)
console.log('\n  at protectDays=120 (the study\'s Detector B window):')
for (const t of ['xavia', 'chaqueta moto verano hombre', 'giacca pelle moto']) {
  const d = decideNegation({ term: t, config: { enabled: true, days: 120 }, converted: c120 })
  console.log(`  ${t.padEnd(30)} ${d.allowed ? 'ALLOWED' : 'REFUSED'}${d.evidence ? ` (${d.evidence.orders} orders, €${(d.evidence.salesCents / 100).toFixed(2)})` : ''}`)
}

await prisma.$disconnect()
