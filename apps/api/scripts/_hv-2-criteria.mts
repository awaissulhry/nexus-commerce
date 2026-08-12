/**
 * HV.2 — the criteria, measured before they are chosen. READ-ONLY.
 *
 * Everything the plan needs a number for:
 *   1. the attribution ramp — is recent search-term data structurally under-counted?
 *   2. the match-type cross-product, under BOTH aggregation readings
 *   3. clicks and ACoS distributions, so the proposed defaults are derived not invented
 *   4. per-scope divergence — do the markets actually want different numbers?
 *   5. what a 2-day latency skip does to every count
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const now = Date.now()
const pct = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))] }
const dist = (xs: number[], f: (n: number) => string) =>
  xs.length ? `min ${f(Math.min(...xs))} · p25 ${f(pct(xs, .25))} · med ${f(pct(xs, .5))} · p75 ${f(pct(xs, .75))} · p90 ${f(pct(xs, .9))} · max ${f(Math.max(...xs))}` : '(none)'

console.log('\n═══ HV.2 — the criteria, measured ═══\n')

// ── 1 · the attribution ramp ──────────────────────────────────────────────────
// `ads-report-create-st` requests yesterday() ONLY, once, at 01:30 UTC, and never re-requests.
// `orders7d` is a SEVEN-DAY attribution window snapshotted after ~one day. If that matters, recent
// dates must carry visibly fewer orders per click than older ones.
console.log('═══ 1 · is recent data under-attributed? ═══\n')
const ramp = await prisma.$queryRaw<Array<{ d: Date; rows: bigint; clicks: bigint; orders: bigint; sales: bigint }>>`
  SELECT date AS d, COUNT(*)::bigint AS rows, SUM(clicks)::bigint AS clicks,
         SUM("orders7d")::bigint AS orders, SUM("sales7dCents")::bigint AS sales
  FROM "AmazonAdsSearchTerm" WHERE date >= NOW() - INTERVAL '30 days'
  GROUP BY date ORDER BY date DESC
`
console.log(`${pad('date', 12)} ${pad('age', 5)} ${pad('rows', 6)} ${pad('clicks', 7)} ${pad('orders', 7)} ${pad('CVR', 7)} sales`)
for (const r of ramp) {
  const age = Math.round((now - r.d.getTime()) / 86_400_000)
  const c = Number(r.clicks), o = Number(r.orders)
  console.log(`${pad(r.d.toISOString().slice(0, 10), 12)} ${pad(`${age}d`, 5)} ${pad(int(Number(r.rows)), 6)} ${pad(int(c), 7)} ${pad(int(o), 7)} ${pad(c ? `${((o / c) * 100).toFixed(2)}%` : '—', 7)} ${eur(Number(r.sales))}`)
}
const band = (lo: number, hi: number) => {
  const rows = ramp.filter((r) => { const a = (now - r.d.getTime()) / 86_400_000; return a >= lo && a < hi })
  const c = rows.reduce((s, r) => s + Number(r.clicks), 0), o = rows.reduce((s, r) => s + Number(r.orders), 0)
  return { days: rows.length, clicks: c, orders: o, cvr: c ? (o / c) * 100 : 0 }
}
console.log('\nconversion rate by data age — the ramp, if there is one:')
for (const [lo, hi, label] of [[0, 3, '0–2 days old'], [3, 8, '3–7 days old'], [8, 15, '8–14 days old'], [15, 31, '15–30 days old']] as Array<[number, number, string]>) {
  const b = band(lo, hi)
  console.log(`  ${pad(label, 16)} ${pad(`${b.days} days`, 9)} clicks ${pad(int(b.clicks), 7)} orders ${pad(int(b.orders), 6)} CVR ${b.cvr.toFixed(2)}%`)
}
console.log('\n⇒ if CVR climbs with age, the freshest days are under-attributed and a threshold applied')
console.log('  to them is stricter than the same threshold applied to older traffic.')

// ── the candidate set, rebuilt exactly as keyword-harvest.service.ts does ──────
const since60 = new Date(now - 60 * 86_400_000)
const grouped = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'marketplace', 'matchType'],
  where: { date: { gte: since60 } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
interface Agg { query: string; campaignId: string; adGroupId: string; marketplace: string; clicks: number; cost: number; orders: number; sales: number; byMatch: Map<string, number> }
const build = (rows: typeof grouped) => {
  const m = new Map<string, Agg>()
  for (const r of rows) {
    const k = `${r.marketplace}|${r.campaignId}|${r.adGroupId}|${r.query.trim().toLowerCase()}`
    const a = m.get(k) ?? { query: r.query, campaignId: r.campaignId, adGroupId: r.adGroupId, marketplace: r.marketplace, clicks: 0, cost: 0, orders: 0, sales: 0, byMatch: new Map<string, number>() }
    const o = r._sum.orders7d ?? 0
    a.clicks += r._sum.clicks ?? 0
    a.cost += Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
    a.orders += o
    a.sales += r._sum.sales7dCents ?? 0
    if (o > 0) a.byMatch.set(String(r.matchType), (a.byMatch.get(String(r.matchType)) ?? 0) + o)
    m.set(k, a)
  }
  return [...m.values()]
}
const all = build(grouped)

const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())
/** §4.2 — harvestable only where the term arrived through a LOOSER match than the one we'd create. */
const LOOSER = new Set(['TARGETING_EXPRESSION_PREDEFINED', 'TARGETING_EXPRESSION', 'BROAD', 'PHRASE'])
const anyLooser = (a: Agg) => [...a.byMatch.keys()].some((m) => LOOSER.has(m))
const allExact = (a: Agg) => a.orders > 0 && (a.byMatch.get('EXACT') ?? 0) === a.orders
const anyExact = (a: Agg) => (a.byMatch.get('EXACT') ?? 0) > 0

// existence join, same as the service
const positives = await prisma.adTarget.findMany({ where: { isNegative: false, kind: { in: ['KEYWORD', 'PRODUCT'] } }, select: { adGroupId: true, kind: true, expressionType: true, expressionValue: true, externalTargetId: true } })
const ags = await prisma.adGroup.findMany({ select: { id: true, externalAdGroupId: true } })
const agByExt = new Map(ags.filter((a) => a.externalAdGroupId).map((a) => [a.externalAdGroupId!, a]))
const isExactType = (t: string | null) => String(t ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '') === 'EXACT'
const here = new Map<string, typeof positives>(); const anywhere = new Map<string, typeof positives>()
for (const p of positives) {
  if (!(p.kind === 'PRODUCT' || isExactType(p.expressionType))) continue
  const t = `${p.kind === 'PRODUCT' ? 'PRODUCT' : 'KEYWORD'}|${p.expressionValue.trim().toLowerCase()}`
  here.set(`${p.adGroupId}|${t}`, [...(here.get(`${p.adGroupId}|${t}`) ?? []), p])
  anywhere.set(t, [...(anywhere.get(t) ?? []), p])
}
const statusOf = (a: Agg) => {
  const key = `${isAsin(a.query) ? 'PRODUCT' : 'KEYWORD'}|${a.query.trim().toLowerCase()}`
  const ag = agByExt.get(a.adGroupId)
  const h = ag ? here.get(`${ag.id}|${key}`) : undefined
  if (h?.length) return h.some((x) => x.externalTargetId != null) ? 'already-exact-here' : 'local-only'
  return anywhere.get(key)?.length ? 'exact-elsewhere' : 'new'
}

// ── 2 · the cross-product, both readings ──────────────────────────────────────
console.log('\n\n═══ 2 · the match-type cross-product ═══\n')
for (const minOrders of [2, 1]) {
  const cands = all.filter((a) => a.orders >= minOrders)
  console.log(`\n── minOrders ≥ ${minOrders}: ${cands.length} candidates`)
  const cell = new Map<string, number>()
  for (const a of cands) {
    const cls = isAsin(a.query) ? 'product' : allExact(a) ? 'EXACT-only' : anyExact(a) ? 'mixed (some EXACT)' : 'looser-only'
    const k = `${cls}|${statusOf(a)}`
    cell.set(k, (cell.get(k) ?? 0) + 1)
  }
  const classes = ['looser-only', 'mixed (some EXACT)', 'EXACT-only', 'product']
  const statuses = ['new', 'already-exact-here', 'exact-elsewhere', 'local-only']
  console.log(`   ${pad('matched via', 20)} ${statuses.map((s) => pad(s, 20)).join('')}`)
  for (const c of classes) {
    const row = statuses.map((s) => pad(String(cell.get(`${c}|${s}`) ?? 0), 20)).join('')
    console.log(`   ${pad(c, 20)} ${row}`)
  }
  const readingA = cands.filter((a) => !isAsin(a.query) && allExact(a)).length      // "every order via EXACT"
  const readingB = cands.filter((a) => !isAsin(a.query) && anyExact(a)).length      // "any order via EXACT"
  const readingC = cands.filter((a) => !isAsin(a.query) && !anyLooser(a)).length    // "no looser match at all"
  console.log(`\n   excluded by reading A "every order came via EXACT":  ${readingA}  → survivors ${cands.length - readingA}`)
  console.log(`   excluded by reading B "any order came via EXACT":    ${readingB}  → survivors ${cands.length - readingB}`)
  console.log(`   excluded by reading C "no LOOSER match at all":      ${readingC}  → survivors ${cands.length - readingC}`)
}

// ── 3 · distributions for the defaults ────────────────────────────────────────
console.log('\n\n═══ 3 · clicks and ACoS, so the defaults are derived ═══\n')
for (const minOrders of [1, 2]) {
  const c = all.filter((a) => a.orders >= minOrders && !isAsin(a.query))
  const clicks = c.map((a) => a.clicks)
  const acos = c.filter((a) => a.sales > 0).map((a) => (a.cost / a.sales) * 100)
  console.log(`\n── minOrders ≥ ${minOrders} (${c.length} keyword candidates)`)
  console.log(`   clicks : ${dist(clicks, (n) => String(Math.round(n)))}`)
  console.log(`   ACoS   : ${dist(acos, (n) => `${n.toFixed(0)}%`)}   (${c.length - acos.length} rows have no sales, so no ACoS)`)
  for (const t of [1, 3, 5, 10, 15, 20]) console.log(`   clicks ≥ ${pad(String(t), 3)} keeps ${pad(String(clicks.filter((x) => x >= t).length), 4)} of ${c.length}`)
  for (const t of [20, 30, 40, 50, 75, 100]) console.log(`   ACoS  ≤ ${pad(`${t}%`, 4)} keeps ${pad(String(c.filter((a) => a.sales > 0 && (a.cost / a.sales) * 100 <= t).length), 4)} of ${c.length}  (rows with no sales excluded)`)
}

// ── 4 · per-scope divergence ──────────────────────────────────────────────────
console.log('\n\n═══ 4 · do the markets actually want different numbers? ═══\n')
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, externalCampaignId: true, portfolioId: true, marketplace: true } })
const campByExt = new Map(camps.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c]))
const survives = (a: Agg, minOrders: number, minClicks: number, maxAcos: number | null) =>
  a.orders >= minOrders && a.clicks >= minClicks && (maxAcos == null || (a.sales > 0 && (a.cost / a.sales) * 100 <= maxAcos)) && !allExact(a)
console.log(`${pad('scope', 34)} ${pad('cands@2', 8)} ${pad('cands@1', 8)} ${pad('med clicks', 11)} ${pad('med ACoS', 9)} survivors 2/10c/40%`)
const groups: Array<[string, (a: Agg) => boolean]> = [
  ['ACCOUNT (all markets)', () => true],
  ...['IT', 'DE', 'ES', 'FR'].map((m) => [`market ${m}`, (a: Agg) => a.marketplace === m] as [string, (a: Agg) => boolean]),
]
const pfIds = [...new Set(camps.map((c) => c.portfolioId).filter((x): x is string => !!x))]
for (const pf of pfIds) {
  const ids = new Set(camps.filter((c) => c.portfolioId === pf).map((c) => c.externalCampaignId));
  groups.push([`portfolio ${pf}`, (a: Agg) => ids.has(a.campaignId)])
}
for (const [label, f] of groups) {
  const g = all.filter((a) => f(a) && !isAsin(a.query))
  const c2 = g.filter((a) => a.orders >= 2), c1 = g.filter((a) => a.orders >= 1)
  if (!c1.length) { console.log(`${pad(label, 34)} ${pad('0', 8)} ${pad('0', 8)} ${pad('—', 11)} ${pad('—', 9)} 0`); continue }
  const medC = pct(c1.map((a) => a.clicks), .5)
  const acos = c1.filter((a) => a.sales > 0).map((a) => (a.cost / a.sales) * 100)
  console.log(`${pad(label, 34)} ${pad(String(c2.length), 8)} ${pad(String(c1.length), 8)} ${pad(String(Math.round(medC)), 11)} ${pad(acos.length ? `${pct(acos, .5).toFixed(0)}%` : '—', 9)} ${g.filter((a) => survives(a, 2, 10, 40)).length}`)
}

// ── 5 · the latency skip ──────────────────────────────────────────────────────
console.log('\n\n═══ 5 · what a 2-day latency skip does ═══\n')
for (const skip of [0, 1, 2, 3]) {
  const until = new Date(now - skip * 86_400_000)
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'campaignId', 'adGroupId', 'marketplace', 'matchType'],
    where: { date: { gte: since60, lte: until } },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const a = build(rows)
  const c2 = a.filter((x) => x.orders >= 2), c1 = a.filter((x) => x.orders >= 1)
  console.log(`  skip ${skip}d (≤ ${until.toISOString().slice(0, 10)}): candidates@2 = ${pad(String(c2.length), 4)} candidates@1 = ${pad(String(c1.length), 4)} groups = ${int(a.length)}`)
}
console.log('\n⇒ a skip only removes the tail if the tail HAS candidates. Compare against §1 above:')
console.log('  the freshest days are the ones with the least attribution, so they contribute few')
console.log('  multi-order terms in the first place.')

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
