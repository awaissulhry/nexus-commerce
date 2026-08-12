/**
 * HV.1 — the candidate read, measured before it is built. READ-ONLY.
 *
 * Reproduces every number the page will render, using the SAME query the service will use, so
 * "the page says 14" can be checked against a script rather than against a screenshot.
 *
 * Measures, in order:
 *   1. freshness — max(date) vs max(createdAt) on AmazonAdsSearchTerm, and the ingest's own claim
 *   2. the marketplace column: is it populated, and does scope actually reach the query?
 *   3. the four candidate states resolved against AdTarget (new / already-exact-here /
 *      exact-elsewhere / local-only)
 *   4. `negatedIn` — the D5 read-only flag, per candidate
 *   5. the auto-targeting blind spot, split by expression type
 *   6. what the engine ACTUALLY wrote each night vs what its cron line claims
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const now = Date.now()

console.log('\n═══ HV.1 — the candidate read ═══\n')

// ── 1 · freshness ─────────────────────────────────────────────────────────────
console.log('═══ 1 · how fresh is the signal, really ═══\n')
const st = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true, createdAt: true }, _min: { date: true }, _count: true })
const maxDate = st._max.date!
const ageDays = Math.floor((now - maxDate.getTime()) / 86_400_000)
console.log(`AmazonAdsSearchTerm: ${int(st._count)} rows · ${st._min.date?.toISOString().slice(0, 10)} → ${maxDate.toISOString().slice(0, 10)}`)
console.log(`  newest row WRITTEN at: ${st._max.createdAt?.toISOString()}`)
console.log(`  age of the newest DATE: ${ageDays} day(s)   ← the number the page must compute, not hard-code`)
const byDate = await prisma.amazonAdsSearchTerm.groupBy({ by: ['date'], _count: true, orderBy: { date: 'desc' }, take: 7 })
console.log('\n  last 7 dates held:')
for (const d of byDate) console.log(`    ${d.date.toISOString().slice(0, 10)}  ${int(d._count)} rows`)

// ── 2 · does scope reach the query? ───────────────────────────────────────────
console.log('\n\n═══ 2 · the marketplace column, and the scope join ═══\n')
const byMkt = await prisma.amazonAdsSearchTerm.groupBy({ by: ['marketplace'], _count: true })
console.log(`marketplace on AmazonAdsSearchTerm: ${byMkt.map((m) => `${m.marketplace}=${int(m._count)}`).join(' · ')}`)
const nullMkt = await prisma.amazonAdsSearchTerm.count({ where: { marketplace: '' } })
console.log(`  empty-string marketplace: ${nullMkt}`)

// the join keys: AmazonAdsSearchTerm.campaignId/adGroupId are EXTERNAL ids
const since60 = new Date(now - 60 * 86_400_000)
const grouped = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
  where: { date: { gte: since60 } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
console.log(`\n60-day groups (query × campaign × adGroup × market): ${int(grouped.length)}`)
const extCampIds = [...new Set(grouped.map((g) => g.campaignId))]
const extAgIds = [...new Set(grouped.map((g) => g.adGroupId))]
const camps = await prisma.campaign.findMany({ where: { externalCampaignId: { in: extCampIds } }, select: { id: true, name: true, externalCampaignId: true, targetingType: true, marketplace: true, status: true, portfolioId: true } })
const ags = await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: extAgIds } }, select: { id: true, name: true, externalAdGroupId: true, campaignId: true } })
console.log(`  external campaign ids in the data: ${extCampIds.length} → resolve to a local Campaign: ${camps.length}`)
console.log(`  external ad group ids in the data: ${extAgIds.length} → resolve to a local AdGroup: ${ags.length}`)
console.log(`  ⇒ ${extCampIds.length - camps.length} campaign ids and ${extAgIds.length - ags.length} ad group ids have NO local row`)

const campByExt = new Map(camps.map((c) => [c.externalCampaignId!, c]))
const agByExt = new Map(ags.map((a) => [a.externalAdGroupId!, a]))

// ── 3 · the four candidate states ─────────────────────────────────────────────
console.log('\n\n═══ 3 · the four candidate states, at minOrders 1/2/3 ═══\n')
const positives = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { id: true, adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true, bidCents: true, status: true },
})
console.log(`positive KEYWORD AdTarget rows: ${int(positives.length)}`)
// key: adGroupId|lower(text) for "here"; lower(text) for "anywhere"
const exactHere = new Map<string, typeof positives>()
const exactAnywhere = new Map<string, typeof positives>()
for (const p of positives) {
  const t = p.expressionValue.trim().toLowerCase()
  const isExact = (p.expressionType ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '') === 'EXACT'
  if (!isExact) continue
  const k1 = `${p.adGroupId}|${t}`
  exactHere.set(k1, [...(exactHere.get(k1) ?? []), p])
  exactAnywhere.set(t, [...(exactAnywhere.get(t) ?? []), p])
}

// negatives, for the D5 flag. 🔴 isNegative, NEVER expressionType.
const negatives = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: true },
  select: { expressionValue: true, adGroupId: true, negativeLevel: true, status: true, externalTargetId: true },
})
const negByTerm = new Map<string, number>()
for (const n of negatives) {
  const t = n.expressionValue.trim().toLowerCase()
  negByTerm.set(t, (negByTerm.get(t) ?? 0) + 1)
}
console.log(`negative KEYWORD AdTarget rows: ${int(negatives.length)} over ${int(negByTerm.size)} distinct terms`)

const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())

function resolveState(query: string, externalAdGroupId: string): { status: string; detail: string } {
  const t = query.trim().toLowerCase()
  const localAg = agByExt.get(externalAdGroupId)
  const here = localAg ? exactHere.get(`${localAg.id}|${t}`) : undefined
  if (here?.length) {
    // 🔴 local-only is a STATUS, not an absence. If NO row of the matching set reached Amazon,
    // the keyword does not exist where it counts.
    const reached = here.filter((h) => h.externalTargetId != null)
    return reached.length
      ? { status: 'already-exact-here', detail: `${here.length} row(s), ${reached.length} at Amazon, bid ${eur(reached[0].bidCents)}` }
      : { status: 'local-only', detail: `${here.length} row(s), NONE reached Amazon` }
  }
  const anywhere = exactAnywhere.get(t)
  if (anywhere?.length) return { status: 'exact-elsewhere', detail: `${anywhere.length} row(s) in other ad groups` }
  return { status: 'new', detail: '' }
}

for (const minOrders of [1, 2, 3]) {
  const cands = grouped
    .filter((g) => (g._sum.orders7d ?? 0) >= minOrders && !isAsin(g.query))
    .sort((a, b) => (b._sum.orders7d ?? 0) - (a._sum.orders7d ?? 0))
  const tally = new Map<string, number>()
  for (const c of cands) tally.set(resolveState(c.query, c.adGroupId).status, (tally.get(resolveState(c.query, c.adGroupId).status) ?? 0) + 1)
  console.log(`minOrders ≥ ${minOrders}: ${cands.length} keyword candidates — ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
}

// the default threshold, in full — this is the grid
console.log('\nthe grid at the DEFAULT threshold (2 orders / 60 days):\n')
const rows = grouped
  .filter((g) => (g._sum.orders7d ?? 0) >= 2 && !isAsin(g.query))
  .sort((a, b) => (b._sum.orders7d ?? 0) - (a._sum.orders7d ?? 0))
console.log(`${pad('query', 38)} ${pad('mkt', 4)} ${pad('ord', 4)} ${pad('clicks', 7)} ${pad('spend', 9)} ${pad('CPC', 7)} ${pad('ACoS', 6)} ${pad('status', 20)} ${pad('neg', 4)} targeting`)
let sumSpend = 0, sumSales = 0
for (const r of rows) {
  const clicks = r._sum.clicks ?? 0
  const cost = Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
  const sales = r._sum.sales7dCents ?? 0
  sumSpend += cost; sumSales += sales
  const cpc = clicks > 0 ? cost / clicks : null
  const acos = sales > 0 ? (cost / sales) * 100 : null
  const s = resolveState(r.query, r.adGroupId)
  const camp = campByExt.get(r.campaignId)
  const neg = negByTerm.get(r.query.trim().toLowerCase()) ?? 0
  console.log(`${pad(r.query, 38)} ${pad(r.marketplace, 4)} ${pad(String(r._sum.orders7d ?? 0), 4)} ${pad(int(clicks), 7)} ${pad(eur(cost), 9)} ${pad(cpc == null ? '—' : eur(cpc), 7)} ${pad(acos == null ? '—' : `${acos.toFixed(0)}%`, 6)} ${pad(s.status, 20)} ${pad(String(neg), 4)} ${camp?.targetingType ?? '(no local campaign)'}`)
}
console.log(`\ntotals: ${rows.length} candidates · spend ${eur(sumSpend)} · sales ${eur(sumSales)} · blended ACoS ${sumSales > 0 ? ((sumSpend / sumSales) * 100).toFixed(0) : '—'}%`)

// ── 4 · the negation overlap, stated as the page will state it ────────────────
console.log('\n\n═══ 4 · the D5 flag — candidates already negated somewhere ═══\n')
const negated = rows.filter((r) => (negByTerm.get(r.query.trim().toLowerCase()) ?? 0) > 0)
console.log(`of ${rows.length} candidates at the default threshold, ${negated.length} are already negated somewhere in the account`)
for (const r of negated.slice(0, 20)) {
  const t = r.query.trim().toLowerCase()
  const ns = negatives.filter((n) => n.expressionValue.trim().toLowerCase() === t)
  const live = ns.filter((n) => n.status === 'ENABLED' && n.externalTargetId != null).length
  console.log(`  ${pad(r.query, 40)} negated in ${pad(String(ns.length), 4)} rows (${live} enabled + confirmed at Amazon) · levels ${[...new Set(ns.map((n) => n.negativeLevel ?? 'AD_GROUP'))].join('/')}`)
}

// ── 5 · the blind spot, by expression type ────────────────────────────────────
console.log('\n\n═══ 5 · the auto-targeting blind spot ═══\n')
const byType = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['matchType'], where: { date: { gte: since60 } }, _count: true, _sum: { orders7d: true },
})
console.log(`${pad('matchType', 36)} ${pad('rows', 8)} orders   visible to promote_to_exact?`)
for (const t of byType.sort((a, b) => b._count - a._count)) {
  const mt = t.matchType
  const visible = mt === 'BROAD' || mt === 'PHRASE' || mt === null
  console.log(`${pad(String(mt), 36)} ${pad(int(t._count), 8)} ${pad(String(t._sum.orders7d ?? 0), 8)} ${visible ? 'yes' : '🔴 NO'}`)
}
const nullMatch = await prisma.amazonAdsSearchTerm.count({ where: { matchType: null } })
console.log(`\nrows with matchType = NULL (the branch the comment explains as "auto-targeting"): ${nullMatch}`)

// ── 6 · what the engine actually wrote, vs what its cron line claims ──────────
console.log('\n\n═══ 6 · the engine — claimed vs written ═══\n')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 10,
  select: { startedAt: true, status: true, outputSummary: true },
})
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 9)} ${r.outputSummary ?? ''}`)

const engineLogs = await prisma.advertisingActionLog.findMany({
  where: { userId: 'automation:auto-harvest' },
  select: { actionType: true, createdAt: true, entityId: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`\nAdvertisingActionLog rows written by automation:auto-harvest, all time: ${int(engineLogs.length)}`)
const byDay = new Map<string, Map<string, number>>()
for (const l of engineLogs) {
  const d = l.createdAt.toISOString().slice(0, 10)
  const m = byDay.get(d) ?? new Map<string, number>()
  m.set(l.actionType, (m.get(l.actionType) ?? 0) + 1)
  byDay.set(d, m)
}
console.log('\nby day (newest 12) — 🔴 compare with the cron line above:')
for (const [d, m] of [...byDay.entries()].sort().reverse().slice(0, 12)) {
  console.log(`  ${d}  ${[...m.entries()].map(([a, n]) => `${a}=${n}`).join(' · ')}`)
}
console.log('\n⇒ a night with a cron line and NO log row on that date wrote nothing: every candidate')
console.log('  it "applied" was already there and the idempotence guards returned the existing row.')

// how many of the 8 negative candidates already exist as a campaign-scope negative
const negPrev = grouped.filter((g) => (g._sum.orders7d ?? 0) === 0 && Math.round(Number(g._sum.costMicros ?? 0n) / 10000) >= 1500 && !isAsin(g.query))
console.log(`\nnegative candidates at the default threshold (0 orders, spend ≥ €15): ${negPrev.length}`)
for (const n of negPrev) {
  const t = n.query.trim().toLowerCase()
  const camp = campByExt.get(n.campaignId)
  const existing = negatives.filter((x) => x.expressionValue.trim().toLowerCase() === t)
  const campScope = existing.filter((x) => x.negativeLevel === 'CAMPAIGN').length
  console.log(`  ${pad(n.query, 34)} ${pad(eur(Math.round(Number(n._sum.costMicros ?? 0n) / 10000)), 9)} already negated: ${pad(String(existing.length), 4)} rows (${campScope} campaign-scope) · ${camp?.name ?? '?'}`)
}

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
