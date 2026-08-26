/** NEG part 2 — negated vs still-running: funnel architecture or a real block? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true, kind: 'KEYWORD' },
  select: { expressionValue: true, expressionType: true, adGroup: { select: { name: true, campaign: { select: { name: true, marketplace: true } } } } },
})
const negByPhrase = new Map<string, Array<{ camp: string; ag: string; mt: string }>>()
for (const n of negs) {
  const k = (n.expressionValue ?? '').trim().toLowerCase()
  if (!k) continue
  if (!negByPhrase.has(k)) negByPhrase.set(k, [])
  negByPhrase.get(k)!.push({ camp: n.adGroup?.campaign?.name ?? '—', ag: n.adGroup?.name ?? '—', mt: String(n.expressionType) })
}

// Recent traffic (30d) for those exact phrases — still running means NOT blocked account-wide.
const recent = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  _sum: { impressions: true, costMicros: true, sales7dCents: true, orders7d: true },
})
const recentBy = new Map(recent.map((r) => [r.query.trim().toLowerCase(), {
  impr: r._sum.impressions ?? 0, spend: Number(r._sum.costMicros ?? 0n) / 1e6,
  sales: (r._sum.sales7dCents ?? 0) / 100, orders: r._sum.orders7d ?? 0,
}]))

// The 120d converters that are also negated somewhere.
const hist = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: new Date(Date.now() - 120 * 86_400_000) } },
  _sum: { sales7dCents: true, orders7d: true },
})
const converters = hist.filter((h) => (h._sum.orders7d ?? 0) > 0).map((h) => h.query.trim().toLowerCase())
const negatedConverters = converters.filter((q) => negByPhrase.has(q))

console.log(`\n── negated phrases that converted: ${negatedConverters.length} ──`)
console.log(`${pad('phrase', 38)} ${pad('negated in', 11)} ${pad('30d impr', 9)} ${pad('30d sales', 10)} verdict`)
let stillRunning = 0, wentDark = 0
for (const q of negatedConverters) {
  const where = negByPhrase.get(q)!
  const r = recentBy.get(q)
  const live = (r?.impr ?? 0) > 0
  if (live) stillRunning++; else wentDark++
  console.log(`${pad(q, 38)} ${pad(`${where.length} ad grp`, 11)} ${pad((r?.impr ?? 0).toLocaleString('en-IE'), 9)} ${pad(`€${(r?.sales ?? 0).toFixed(2)}`, 10)} ${live ? 'still running elsewhere' : '🔴 NO traffic in 30d'}`)
}
console.log(`\n  still running elsewhere (funnelled, not blocked): ${stillRunning}`)
console.log(`  no traffic at all in 30d (possibly blocked)     : ${wentDark}`)

// Where exactly is each dark one negated?
console.log(`\n── the dark ones, and where they are negated ──`)
for (const q of negatedConverters) {
  if ((recentBy.get(q)?.impr ?? 0) > 0) continue
  console.log(`  "${q}"`)
  for (const w of negByPhrase.get(q)!.slice(0, 6)) console.log(`      ${pad(w.mt, 16)} ${w.camp}  ›  ${w.ag}`)
}
await prisma.$disconnect()
