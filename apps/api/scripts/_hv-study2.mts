/** HV part 2 — is the threshold right, did promotions perform, and are there duplicates? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: new Date(Date.now() - 60 * 86_400_000) } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
const kws = await prisma.adTarget.findMany({ where: { kind: 'KEYWORD', isNegative: false }, select: { expressionValue: true, expressionType: true } })
const exactSet = new Set(kws.filter((k) => String(k.expressionType).toUpperCase().includes('EXACT')).map((k) => (k.expressionValue ?? '').trim().toLowerCase()))
const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q)

console.log('\n── how the opportunity changes with the threshold ──')
console.log(`${pad('min orders', 12)} ${pad('converting', 11)} ${pad('already exact', 14)} ${pad('UNHARVESTED', 12)} unharvested sales`)
for (const min of [1, 2, 3, 5]) {
  const c = terms.map((t) => ({
    q: t.query.trim().toLowerCase(), o: t._sum.orders7d ?? 0,
    s: (t._sum.sales7dCents ?? 0) / 100, sp: Number(t._sum.costMicros ?? 0n) / 1e6, cl: t._sum.clicks ?? 0,
  })).filter((t) => t.o >= min && !isAsin(t.q))
  const un = c.filter((x) => !exactSet.has(x.q))
  console.log(`${pad(`≥ ${min}`, 12)} ${pad(int(c.length), 11)} ${pad(int(c.length - un.length), 14)} ${pad(int(un.length), 12)} €${un.reduce((a, x) => a + x.s, 0).toFixed(2)}`)
}
const one = terms.map((t) => ({
  q: t.query.trim().toLowerCase(), o: t._sum.orders7d ?? 0,
  s: (t._sum.sales7dCents ?? 0) / 100, sp: Number(t._sum.costMicros ?? 0n) / 1e6, cl: t._sum.clicks ?? 0,
})).filter((t) => t.o === 1 && !isAsin(t.q) && !exactSet.has(t.q)).sort((a, b) => b.s - a.s)
console.log(`\n── single-order converters with NO exact keyword (the threshold's blind spot): ${one.length} ──`)
console.log(`${pad('  term', 44)} ${pad('sales', 10)} ${pad('spend', 9)} ${pad('ACoS', 6)} CPC`)
for (const u of one.slice(0, 15)) console.log(`${pad(`  ${u.q}`, 44)} ${pad(`€${u.s.toFixed(2)}`, 10)} ${pad(`€${u.sp.toFixed(2)}`, 9)} ${pad(u.s > 0 ? `${((u.sp / u.s) * 100).toFixed(0)}%` : '—', 6)} €${(u.cl > 0 ? u.sp / u.cl : 0).toFixed(2)}`)
console.log(`  combined: €${one.reduce((a, x) => a + x.s, 0).toFixed(2)} sales on €${one.reduce((a, x) => a + x.sp, 0).toFixed(2)} spend`)

// duplicates
const dupes = await prisma.$queryRaw<Array<{ v: string; ag: string; n: bigint }>>`
  SELECT lower(trim("expressionValue")) AS v, "adGroupId" AS ag, COUNT(*)::bigint AS n
  FROM "AdTarget" WHERE kind = 'KEYWORD' AND "isNegative" = false AND "expressionValue" IS NOT NULL
  GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC LIMIT 12`
console.log(`\n── duplicate positive keywords (same text, same ad group): ${dupes.length ? `${dupes.length}+ groups` : 'none'} ──`)
for (const d of dupes) console.log(`  ${pad(d.v, 44)} ×${Number(d.n)}`)

// did harvested keywords perform?
const recent = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false, createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) } },
  select: { expressionValue: true, expressionType: true, createdAt: true, impressions: true, clicks: true, spendCents: true, salesCents: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`\n── keywords created in the last 60d: ${int(recent.length)} ──`)
const withImpr = recent.filter((k) => k.impressions > 0)
const withSales = recent.filter((k) => k.salesCents > 0)
console.log(`  have taken impressions : ${int(withImpr.length)}  (${((withImpr.length / Math.max(1, recent.length)) * 100).toFixed(0)}%)`)
console.log(`  have produced sales    : ${int(withSales.length)}  (${((withSales.length / Math.max(1, recent.length)) * 100).toFixed(0)}%)`)
const sp = recent.reduce((a, k) => a + k.spendCents, 0) / 100, sa = recent.reduce((a, k) => a + k.salesCents, 0) / 100
console.log(`  combined: €${sp.toFixed(2)} spend · €${sa.toFixed(2)} sales · ACoS ${sa > 0 ? ((sp / sa) * 100).toFixed(0) : '—'}%`)

const sugg = await prisma.adsRuleSuggestion.findMany({ where: { status: 'PENDING' }, select: { kind: true, createdAt: true } }).catch(() => [])
const byKind = new Map<string, number>()
for (const s of sugg) byKind.set(String((s as { kind?: string }).kind ?? '—'), (byKind.get(String((s as { kind?: string }).kind ?? '—')) ?? 0) + 1)
console.log(`\n── the 225 pending suggestions, by kind ──`)
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 30)} ${int(n)}`)
await prisma.$disconnect()
