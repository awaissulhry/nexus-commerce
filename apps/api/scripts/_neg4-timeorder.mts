/**
 * NEG.4 — 🔴 does the traffic PREDATE the negation? READ-ONLY.
 *
 * Every 120-day "conflict" has its last impression at or just after the negation's creation date.
 * That is not a conflict — it is the negative WORKING: the term took traffic, someone negated it,
 * the traffic stopped. A window-only overlap counts pre-negation traffic as evidence that the
 * negation is blocking live traffic, which is a false-positive generator.
 *
 * This measures the corrected predicate: traffic strictly AFTER the negation was created.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: { id: true, expressionValue: true, status: true, externalTargetId: true, negativeLevel: true, createdAt: true,
    adGroup: { select: { externalAdGroupId: true, name: true, campaign: { select: { status: true, name: true } } } } },
})
const blocks = (n: typeof negs[number]) => n.externalTargetId != null && String(n.status) === 'ENABLED'
  && n.adGroup?.campaign?.status === 'ENABLED' && n.negativeLevel !== 'CAMPAIGN'
const byTerm = new Map<string, typeof negs>()
for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); const a = byTerm.get(k) ?? []; a.push(n); byTerm.set(k, a) }

for (const w of [30, 60, 120]) {
  const since = new Date(Date.now() - w * 86400_000)
  // per (query, adGroup, DATE) so we can compare the traffic date to the negation's creation
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'adGroupId', 'date'],
    where: { date: { gte: since }, query: { in: [...byTerm.keys()] } },
    _sum: { impressions: true, clicks: true, orders7d: true, sales7dCents: true, costMicros: true },
  })
  let windowOnly = 0, afterCreation = 0
  const kept: string[] = []
  const seenPair = new Set<string>(), seenPairAfter = new Set<string>()
  for (const r of rows) {
    const t = normaliseNegTerm(r.query)
    const here = (byTerm.get(t) ?? []).filter((n) => n.adGroup?.externalAdGroupId === r.adGroupId && blocks(n))
    if (here.length === 0) continue
    const pair = `${t}|${r.adGroupId}`
    if (!seenPair.has(pair)) { seenPair.add(pair); windowOnly++ }
    // 🔴 the corrected predicate: the impression must land AFTER the negation existed
    if (here.some((n) => r.date > n.createdAt)) {
      if (!seenPairAfter.has(pair)) { seenPairAfter.add(pair); afterCreation++; kept.push(`${t} @ ${here[0].adGroup?.name}`) }
    }
  }
  console.log(`\nwindow ${w}d:`)
  console.log(`  window-only overlap (today's detector):        ${windowOnly}`)
  console.log(`  🔴 traffic AFTER the negation was created:     ${afterCreation}`)
  for (const k of kept) console.log(`     still a conflict: ${k}`)
}
await prisma.$disconnect()
