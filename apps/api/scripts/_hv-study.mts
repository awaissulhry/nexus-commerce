/**
 * HV — Keyword Harvest tab study. READ-ONLY: no writes, no mutations.
 *
 * Harvesting is the auto→manual funnel: a search term that converted under auto/broad targeting
 * gets promoted to its own EXACT keyword so it can be bid on deliberately. This measures the
 * opportunity (converting terms with no exact keyword), what has actually been promoted, whether
 * the promotions performed, and the traps in the promote path.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ HV — Keyword Harvest ═══\n')

// ── 1. the rules the tab claims ───────────────────────────────────────────────
const HARVEST_ACTIONS = ['promote_to_exact', 'harvest_and_negate']
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, executionCount: true, matchCount: true, lastExecutedAt: true, maxExecutionsPerDay: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => HARVEST_ACTIONS.includes(t)))
console.log(`Rules the tab's BADGE counts (key 'keyword-harvest'): ${rules.length}`)
console.log(`Rules the tab's GRID shows (liveType 'keyword-harvesting'): 0  ← the key/prop mismatch\n`)
console.log(`${pad('rule', 42)} ${pad('on', 4)} ${pad('level', 8)} ${pad('trigger', 24)} ${pad('execs', 7)} last`)
for (const r of rules) {
  console.log(`${pad(r.name, 42)} ${pad(r.enabled ? 'ON' : '—', 4)} ${pad(String(r.autonomyLevel), 8)} ${pad(r.trigger, 24)} ${pad(int(r.executionCount), 7)} ${r.lastExecutedAt?.toISOString().slice(0, 10) ?? 'never'}`)
  console.log(`     actions: ${types(r.actions).join(', ')}`)
}

// ── 2. what has actually been created ─────────────────────────────────────────
const since = new Date(Date.now() - 60 * 86_400_000)
const created = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, actionType: 'create_keyword' },
  select: { userId: true, executionId: true, entityId: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true },
})
console.log(`\n── create_keyword writes, 60d: ${int(created.length)} ──`)
const byUser = new Map<string, number>()
for (const c of created) byUser.set(String(c.userId ?? '(none)'), (byUser.get(String(c.userId ?? '(none)')) ?? 0) + 1)
for (const [u, n] of [...byUser].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${pad(u, 48)} ${int(n)}`)
console.log(`  from a rule execution: ${created.filter((c) => c.executionId).length}`)
const st = new Map<string, number>()
for (const c of created) st.set(String(c.amazonResponseStatus ?? '—'), (st.get(String(c.amazonResponseStatus ?? '—')) ?? 0) + 1)
console.log(`  amazonResponseStatus: ${[...st].map(([k, v]) => `${k}=${v}`).join(' · ')}`)

// ── 3. 🔴 THE OPPORTUNITY — converting terms with no EXACT keyword ────────────
const terms = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query'],
  where: { date: { gte: new Date(Date.now() - 60 * 86_400_000) } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
const kws = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { expressionValue: true, expressionType: true },
})
const exactSet = new Set(kws.filter((k) => String(k.expressionType).toUpperCase().includes('EXACT')).map((k) => (k.expressionValue ?? '').trim().toLowerCase()))
const anyKwSet = new Set(kws.map((k) => (k.expressionValue ?? '').trim().toLowerCase()))
const converters = terms
  .map((t) => ({
    q: t.query.trim().toLowerCase(),
    orders: t._sum.orders7d ?? 0,
    sales: (t._sum.sales7dCents ?? 0) / 100,
    spend: Number(t._sum.costMicros ?? 0n) / 1e6,
    clicks: t._sum.clicks ?? 0,
  }))
  .filter((t) => t.orders >= 2 && !/^b0[a-z0-9]{8}$/i.test(t.q))
const unharvested = converters.filter((c) => !exactSet.has(c.q)).sort((a, b) => b.sales - a.sales)
console.log(`\n── the harvest opportunity (60d, the service's own thresholds: orders ≥ 2) ──`)
console.log(`  distinct paid queries               : ${int(terms.length)}`)
console.log(`  converting (≥2 orders, not an ASIN) : ${int(converters.length)}`)
console.log(`  already an EXACT keyword            : ${int(converters.length - unharvested.length)}`)
console.log(`  🔴 NOT yet an exact keyword         : ${int(unharvested.length)}`)
console.log(`     of which no keyword of any type  : ${int(unharvested.filter((u) => !anyKwSet.has(u.q)).length)}`)
if (unharvested.length) {
  const tSales = unharvested.reduce((a, u) => a + u.sales, 0)
  const tSpend = unharvested.reduce((a, u) => a + u.spend, 0)
  console.log(`     combined: €${tSales.toFixed(2)} sales · €${tSpend.toFixed(2)} spend · ACoS ${tSales > 0 ? ((tSpend / tSales) * 100).toFixed(0) : '—'}%`)
  console.log(`\n${pad('  unharvested converting term', 44)} ${pad('orders', 7)} ${pad('sales', 10)} ${pad('spend', 9)} ${pad('ACoS', 6)} ${pad('CPC', 7)} kw?`)
  for (const u of unharvested.slice(0, 20)) {
    const cpc = u.clicks > 0 ? u.spend / u.clicks : 0
    console.log(`${pad(`  ${u.q}`, 44)} ${pad(String(u.orders), 7)} ${pad(`€${u.sales.toFixed(2)}`, 10)} ${pad(`€${u.spend.toFixed(2)}`, 9)} ${pad(u.sales > 0 ? `${((u.spend / u.sales) * 100).toFixed(0)}%` : '—', 6)} ${pad(`€${cpc.toFixed(2)}`, 7)} ${anyKwSet.has(u.q) ? 'other MT' : 'NONE'}`)
  }
}

// ── 4. 🔴 the hard-coded promote bid vs what these terms actually cost ────────
const cpcs = unharvested.filter((u) => u.clicks > 0).map((u) => u.spend / u.clicks).sort((a, b) => a - b)
if (cpcs.length) {
  const at = (p: number) => cpcs[Math.min(cpcs.length - 1, Math.floor(cpcs.length * p))]
  console.log(`\n── promote_to_exact bids every harvested keyword at a hard-coded €0.50 ──`)
  console.log(`  actual CPC of the unharvested converters: p10 €${at(0.1).toFixed(2)} · median €${at(0.5).toFixed(2)} · p90 €${at(0.9).toFixed(2)} · max €${at(1).toFixed(2)}`)
  console.log(`  terms whose real CPC is ABOVE €0.50 (a €0.50 bid may not win): ${cpcs.filter((c) => c > 0.5).length} of ${cpcs.length}`)
  console.log(`  terms whose real CPC is BELOW €0.30 (a €0.50 bid overpays)  : ${cpcs.filter((c) => c < 0.3).length} of ${cpcs.length}`)
}

// ── 5. the proposal queue ─────────────────────────────────────────────────────
const sugg = await prisma.adsRuleSuggestion.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => [])
console.log(`\n── AdsRuleSuggestion (the proposal queue) ──`)
for (const s of sugg) console.log(`  ${pad(String(s.status), 14)} ${int(s._count._all)}`)
const oldest = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }).catch(() => null)
if (oldest) console.log(`  oldest pending: ${oldest.createdAt.toISOString().slice(0, 10)} (${Math.floor((Date.now() - oldest.createdAt.getTime()) / 86_400_000)} days)`)

// ── 6. the engine ─────────────────────────────────────────────────────────────
const crons = await prisma.cronRun.groupBy({
  by: ['jobName'], where: { jobName: { in: ['ads-auto-harvest', 'ads-coverage-engine'] } },
  _count: { _all: true }, _max: { startedAt: true },
})
console.log(`\n── the engines ──`)
for (const n of ['ads-auto-harvest', 'ads-coverage-engine']) {
  const c = crons.find((x) => x.jobName === n)
  console.log(`  ${pad(n, 22)} ${c ? `runs=${int(c._count._all)}  last=${c._max.startedAt?.toISOString().slice(0, 16)}` : 'NEVER RUN'}`)
}

await prisma.$disconnect()
