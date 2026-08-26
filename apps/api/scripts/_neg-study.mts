/**
 * NEG — Negative Targeting tab study. READ-ONLY: no writes, no mutations.
 *
 * A negative is the hardest change in an account to notice later: it removes traffic silently and
 * leaves no row anywhere saying "you used to earn money here". This measures what has been
 * negated, by whom, whether the whitelist held, and — the question that decides whether negation
 * may ever run on AUTO — whether any negative has blocked a query that was converting.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ NEG — Negative Targeting ═══\n')

// ── 1. the rules on the tab ───────────────────────────────────────────────────
const NEG_ACTIONS = ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns']
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, maxExecutionsPerDay: true, executionCount: true, matchCount: true, lastExecutedAt: true, scopeMarketplace: true, scopeCampaignId: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => NEG_ACTIONS.includes(t)))
console.log(`Rules the tab lists: ${rules.length}`)
console.log(`${pad('rule', 40)} ${pad('on', 4)} ${pad('level', 8)} ${pad('trigger', 22)} ${pad('execs', 7)} ${pad('cap/day', 8)} last`)
for (const r of rules) {
  console.log(`${pad(r.name, 40)} ${pad(r.enabled ? 'ON' : '—', 4)} ${pad(String(r.autonomyLevel), 8)} ${pad(r.trigger, 22)} ${pad(int(r.executionCount), 7)} ${pad(String(r.maxExecutionsPerDay ?? '—'), 8)} ${r.lastExecutedAt?.toISOString().slice(0, 10) ?? 'never'}`)
  console.log(`     actions: ${types(r.actions).join(', ')}`)
}

// ── 2. the negatives that exist ───────────────────────────────────────────────
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: { id: true, kind: true, expressionType: true, expressionValue: true, createdAt: true, adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true } } } } },
})
console.log(`\n── the negatives in the account: ${int(negs.length)} ──`)
const byKind = new Map<string, number>()
const byExpr = new Map<string, number>()
for (const n of negs) {
  byKind.set(String(n.kind), (byKind.get(String(n.kind)) ?? 0) + 1)
  byExpr.set(String(n.expressionType ?? 'null'), (byExpr.get(String(n.expressionType ?? 'null')) ?? 0) + 1)
}
console.log(`  by kind          : ${[...byKind].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  by expressionType: ${[...byExpr].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  ← expressionType is the MATCH TYPE, not the negativity. Negativity lives in isNegative.`)
const byMkt = new Map<string, number>()
for (const n of negs) byMkt.set(String(n.adGroup?.campaign?.marketplace ?? '—'), (byMkt.get(String(n.adGroup?.campaign?.marketplace ?? '—')) ?? 0) + 1)
console.log(`  by marketplace   : ${[...byMkt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const days = new Map<string, number>()
for (const n of negs) days.set(n.createdAt.toISOString().slice(0, 10), (days.get(n.createdAt.toISOString().slice(0, 10)) ?? 0) + 1)
console.log(`  created on ${days.size} distinct days; busiest:`)
for (const [d, c] of [...days].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`     ${d}  ${int(c)}`)

// ── 3. who created them ───────────────────────────────────────────────────────
const since = new Date(Date.now() - 60 * 86_400_000)
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
  select: { actionType: true, userId: true, executionId: true, entityId: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true },
})
console.log(`\n── negative writes logged in 60d: ${int(logs.length)} ──`)
const byUser = new Map<string, number>()
for (const l of logs) byUser.set(String(l.userId ?? '(none)'), (byUser.get(String(l.userId ?? '(none)')) ?? 0) + 1)
for (const [u, n] of [...byUser].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${pad(u, 50)} ${int(n)}`)
console.log(`  from a rule execution: ${logs.filter((l) => l.executionId).length}`)
const st = new Map<string, number>()
for (const l of logs) st.set(String(l.amazonResponseStatus ?? '—'), (st.get(String(l.amazonResponseStatus ?? '—')) ?? 0) + 1)
console.log(`  amazonResponseStatus: ${[...st].map(([k, v]) => `${k}=${v}`).join(' · ')}`)

// ── 4. did the whitelist hold? ────────────────────────────────────────────────
const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, isPrefix: true, marketplace: true } })
console.log(`\n── the 10 protected terms vs ${int(negs.length)} negatives ──`)
const violations: Array<{ term: string; neg: string; campaign: string }> = []
for (const n of negs) {
  const v = (n.expressionValue ?? '').toLowerCase()
  for (const p of prot) {
    const t = p.term.toLowerCase()
    const hit = p.isPrefix ? v.startsWith(t) : v.split(/\s+/).includes(t) || v === t
    if (hit) violations.push({ term: p.term, neg: n.expressionValue ?? '', campaign: n.adGroup?.campaign?.name ?? '—' })
  }
}
console.log(`  negatives containing a protected term: ${violations.length}`)
for (const v of violations.slice(0, 15)) console.log(`     🔴 "${v.neg}"  contains protected "${v.term}"  [${v.campaign}]`)
if (!violations.length) console.log(`     ✅ none — the whitelist has held`)

// ── 5. 🔴 has a negative blocked a CONVERTING query? ──────────────────────────
const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: new Date(Date.now() - 120 * 86_400_000) } },
  _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
})
const perfByQuery = new Map(terms.map((t) => [t.query.trim().toLowerCase(), {
  impressions: t._sum.impressions ?? 0, clicks: t._sum.clicks ?? 0,
  spend: Number(t._sum.costMicros ?? 0n) / 1e6, sales: (t._sum.sales7dCents ?? 0) / 100, orders: t._sum.orders7d ?? 0,
}]))
const negValues = [...new Set(negs.map((n) => (n.expressionValue ?? '').trim().toLowerCase()).filter(Boolean))]
console.log(`\n── negated queries that HAD converted (120d search-term history) ──`)
console.log(`  distinct negative phrases: ${int(negValues.length)}`)
const harmed = negValues
  .map((v) => ({ v, p: perfByQuery.get(v) }))
  .filter((x): x is { v: string; p: NonNullable<ReturnType<typeof perfByQuery.get>> } => !!x.p && x.p.orders > 0)
  .sort((a, b) => b.p.sales - a.p.sales)
console.log(`  negatives whose exact phrase has orders in history: ${harmed.length}`)
if (harmed.length) {
  console.log(`${pad('  negated phrase', 44)} ${pad('orders', 7)} ${pad('sales', 10)} ${pad('spend', 9)} ACoS`)
  let lostSales = 0
  for (const h of harmed.slice(0, 20)) {
    lostSales += h.p.sales
    console.log(`${pad(`  ${h.v}`, 44)} ${pad(String(h.p.orders), 7)} ${pad(`€${h.p.sales.toFixed(2)}`, 10)} ${pad(`€${h.p.spend.toFixed(2)}`, 9)} ${h.p.sales > 0 ? `${((h.p.spend / h.p.sales) * 100).toFixed(0)}%` : '—'}`)
  }
  const totalSales = harmed.reduce((a, h) => a + h.p.sales, 0)
  const totalSpend = harmed.reduce((a, h) => a + h.p.spend, 0)
  console.log(`\n  ALL ${harmed.length}: €${totalSales.toFixed(2)} historical sales · €${totalSpend.toFixed(2)} spend · blended ACoS ${totalSpend > 0 && totalSales > 0 ? `${((totalSpend / totalSales) * 100).toFixed(0)}%` : '—'}`)
  console.log(`  ⚠ a negated term with a high ACoS was negated CORRECTLY. The ones to look at are`)
  console.log(`    the low-ACoS rows above — those were profitable and are now blocked.`)
}

// ── 6. is there a retirement path? ────────────────────────────────────────────
const removed = await prisma.advertisingActionLog.count({
  where: { actionType: { contains: 'negative', mode: 'insensitive' }, createdAt: { gte: since }, rolledBackAt: { not: null } },
}).catch(() => -1)
console.log(`\n── retirement ──`)
console.log(`  negative writes rolled back in 60d: ${removed}`)
console.log(`  (a negative-retirement path is the stated blocker on letting negation run AUTO)`)

await prisma.$disconnect()
