/**
 * HV.4a — the de-duplication gate, and a pre-flight on every write HV.4 would make. READ-ONLY.
 *
 * 🔴 Why this is a gate and not a cleanup. `AmazonAdsSearchTerm` has no unique constraint and the
 * ingest deletes by `reportRunId` then bulk-inserts, so a re-ingested date lands a second copy.
 * Every consumer sums via `groupBy`, so a duplicate row **doubles** a term's orders, clicks and
 * spend — and the shipped criteria are `2+ orders · 3+ clicks · ACoS ≤ 45%`. A single duplicated
 * 1-order row can therefore manufacture a 2-order candidate that never existed. On a read-only page
 * that is a wrong number; on the session that turns a candidate into a keyword and a negative on
 * Amazon it is a write nobody earned.
 *
 * Measures, in order:
 *   1. the duplicates: how many, where, and whether the copies are identical or divergent
 *   2. 🔴 the blast radius: every one of the 8 shipped candidates recomputed with duplicates
 *      collapsed — which change, by how much, and whether the candidate set is still 8
 *   3. the collision question the durable fix has to answer (`adGroupId = ''` aggregated rows)
 *   4. a WRITE PRE-FLIGHT: for each candidate, would `checkAdsWriteGate` actually allow the
 *      keyword and the negative? NEG.3b measured the gate refusing 1,014 of 2,058 negatives at
 *      `campaign_allowlist`, so "we would write it" is a claim that has to be checked, not assumed.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ HV.4a — the de-duplication gate ═══\n')

// ── 1 · the duplicates ────────────────────────────────────────────────────────
console.log('═══ 1 · what is duplicated ═══\n')
const dupes = await prisma.$queryRaw<Array<{
  profileId: string; d: Date; campaignId: string; adGroupId: string; query: string; matchType: string | null
  copies: bigint; distinctClicks: bigint; distinctOrders: bigint; distinctCost: bigint
  clicks: bigint; orders: bigint
}>>`
  SELECT "profileId", date AS d, "campaignId", "adGroupId", query, "matchType",
         COUNT(*)::bigint AS copies,
         COUNT(DISTINCT clicks)::bigint     AS "distinctClicks",
         COUNT(DISTINCT "orders7d")::bigint AS "distinctOrders",
         COUNT(DISTINCT "costMicros")::bigint AS "distinctCost",
         SUM(clicks)::bigint AS clicks, SUM(COALESCE("orders7d",0))::bigint AS orders
  FROM "AmazonAdsSearchTerm"
  GROUP BY 1,2,3,4,5,6 HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC, date DESC`
const redundant = dupes.reduce((a, r) => a + (Number(r.copies) - 1), 0)
console.log(`duplicated natural keys: ${int(dupes.length)} · redundant rows: ${int(redundant)}`)
const divergent = dupes.filter((r) => Number(r.distinctClicks) > 1 || Number(r.distinctOrders) > 1 || Number(r.distinctCost) > 1)
console.log(`🔴 keys whose copies DISAGREE on a metric: ${divergent.length}`)
console.log('   (if 0, the copies are byte-identical and "keep any one" is safe; if not, the durable')
console.log('    fix has to say WHICH copy is the truth, and so does the read-side collapse)')
for (const r of divergent.slice(0, 8)) {
  console.log(`   ${r.d.toISOString().slice(0, 10)} ${pad(r.query, 30)} copies=${r.copies} distinct clicks/orders/cost = ${r.distinctClicks}/${r.distinctOrders}/${r.distinctCost}`)
}
const since60 = new Date(Date.now() - 60 * 86_400_000)
const inWindow = dupes.filter((r) => r.d >= since60)
console.log(`\ninside the 60-day window this page reads: ${inWindow.length} keys · ${inWindow.reduce((a, r) => a + Number(r.copies) - 1, 0)} redundant rows`)
if (inWindow.length) {
  const dates = [...new Set(inWindow.map((r) => r.d.toISOString().slice(0, 10)))].sort()
  console.log(`  dates: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} distinct)`)
}

// ── 2 · 🔴 the blast radius on the 8 shipped candidates ───────────────────────
console.log('\n\n═══ 2 · the blast radius — every candidate, with and without duplicates ═══\n')

/** The page's own aggregation, but collapsing the natural key first. */
const raw = await prisma.$queryRaw<Array<{ query: string; campaignId: string; adGroupId: string; marketplace: string; matchType: string | null; clicks: bigint; cost: bigint; orders: bigint; sales: bigint; impressions: bigint; copies: bigint }>>`
  SELECT query, "campaignId", "adGroupId", marketplace, "matchType",
         SUM(clicks)::bigint AS clicks, SUM("costMicros")::bigint AS cost,
         SUM(COALESCE("orders7d",0))::bigint AS orders, SUM(COALESCE("sales7dCents",0))::bigint AS sales,
         SUM(impressions)::bigint AS impressions, COUNT(*)::bigint AS copies
  FROM "AmazonAdsSearchTerm" WHERE date >= ${since60}
  GROUP BY query, "campaignId", "adGroupId", marketplace, "matchType", date, "profileId"`
const dedup = await prisma.$queryRaw<Array<{ query: string; campaignId: string; adGroupId: string; marketplace: string; matchType: string | null; clicks: bigint; cost: bigint; orders: bigint; sales: bigint; impressions: bigint }>>`
  SELECT query, "campaignId", "adGroupId", marketplace, "matchType",
         SUM(clicks)::bigint AS clicks, SUM(cost)::bigint AS cost, SUM(orders)::bigint AS orders,
         SUM(sales)::bigint AS sales, SUM(impressions)::bigint AS impressions
  FROM (
    SELECT DISTINCT ON ("profileId", date, "campaignId", "adGroupId", query, "matchType")
           "profileId", date, "campaignId", "adGroupId", query, marketplace, "matchType",
           clicks, "costMicros" AS cost, COALESCE("orders7d",0) AS orders,
           COALESCE("sales7dCents",0) AS sales, impressions
    FROM "AmazonAdsSearchTerm" WHERE date >= ${since60}
    ORDER BY "profileId", date, "campaignId", "adGroupId", query, "matchType", "createdAt" DESC
  ) t GROUP BY query, "campaignId", "adGroupId", marketplace, "matchType"`

// roll both up to the page's grain (term × campaign × adGroup × market)
type Roll = { clicks: number; cost: number; orders: number; sales: number; impressions: number }
const roll = (rows: Array<{ query: string; campaignId: string; adGroupId: string; marketplace: string; clicks: bigint; cost: bigint; orders: bigint; sales: bigint; impressions: bigint }>) => {
  const m = new Map<string, Roll>()
  for (const r of rows) {
    const k = `${r.marketplace}|${r.campaignId}|${r.adGroupId}|${r.query.trim().toLowerCase()}`
    const a = m.get(k) ?? { clicks: 0, cost: 0, orders: 0, sales: 0, impressions: 0 }
    a.clicks += Number(r.clicks); a.cost += Math.round(Number(r.cost) / 10000)
    a.orders += Number(r.orders); a.sales += Number(r.sales); a.impressions += Number(r.impressions)
    m.set(k, a)
  }
  return m
}
const withDup = roll(raw as never)
const noDup = roll(dedup as never)

const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const page = await getKeywordHarvest({ market: 'all' })
console.log(`candidates as shipped: ${page.census.candidates}\n`)
console.log(`${pad('term', 34)} ${pad('orders', 14)} ${pad('clicks', 14)} ${pad('spend', 20)} changed?`)
let changed = 0
for (const r of page.rows) {
  const k = `${r.market}|${r.campaign.externalId}|${r.adGroup.externalId}|${r.termKey}`
  const a = withDup.get(k), b = noDup.get(k)
  if (!a || !b) { console.log(`${pad(r.term, 34)} (not found in the raw roll-up)`); continue }
  const diff = a.orders !== b.orders || a.clicks !== b.clicks || a.cost !== b.cost
  if (diff) changed++
  console.log(`${pad(r.term, 34)} ${pad(`${a.orders} → ${b.orders}`, 14)} ${pad(`${a.clicks} → ${b.clicks}`, 14)} ${pad(`${eur(a.cost)} → ${eur(b.cost)}`, 20)} ${diff ? '🔴 YES' : 'no'}`)
}
console.log(`\n🔴 candidates whose rollup changes when duplicates collapse: ${changed} of ${page.rows.length}`)

// would the candidate SET change? re-apply the shipped criteria to the deduped roll-up
const crit = page.criteria.inForce
const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())
const survivors = (m: Map<string, Roll>) => {
  let n = 0
  for (const [k, v] of m) {
    const term = k.split('|')[3]
    if (v.orders < crit.minOrders) continue
    if (v.clicks < crit.minClicks) continue
    if (crit.maxAcosPct != null && v.sales > 0 && (v.cost / v.sales) * 100 > crit.maxAcosPct) continue
    void isAsin(term)
    n++
  }
  return n
}
console.log(`\ncriteria in force: ${crit.minOrders}+ orders · ${crit.minClicks}+ clicks · ACoS ≤ ${crit.maxAcosPct}% · ${crit.windowDays}d`)
console.log(`  rows meeting orders/clicks/ACoS WITH duplicates:    ${survivors(withDup)}`)
console.log(`  rows meeting orders/clicks/ACoS WITHOUT duplicates: ${survivors(noDup)}`)
console.log('  (this ignores the match-type criterion, so it is an upper bound on both sides — the')
console.log('   comparison between them is the point, not the absolute numbers)')

// ── 3 · the collision the durable fix must answer ────────────────────────────
console.log('\n\n═══ 3 · the aggregated rows the ingest writes with adGroupId = "" ═══\n')
const agg = await prisma.$queryRaw<Array<{ n: bigint; dates: bigint }>>`
  SELECT COUNT(*)::bigint AS n, COUNT(DISTINCT date)::bigint AS dates
  FROM "AmazonAdsSearchTerm" WHERE "adGroupId" = ''`
console.log(`rows with adGroupId = '' (Amazon aggregated across ad groups): ${int(Number(agg[0].n))} over ${agg[0].dates} dates`)
const aggDup = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM (
    SELECT "profileId", date, "campaignId", "adGroupId", query, "matchType"
    FROM "AmazonAdsSearchTerm" WHERE "adGroupId" = ''
    GROUP BY 1,2,3,4,5,6 HAVING COUNT(*) > 1) t`
console.log(`  of those, natural keys with >1 row: ${int(Number(aggDup[0].n))}`)
console.log('  ⇒ if this is 0 the proposed unique key does not collide on them; if not, the')
console.log('    migration has to decide whether the empty string is a key value or a null-equivalent.')
const nullMatch = await prisma.amazonAdsSearchTerm.count({ where: { matchType: null } })
console.log(`\nrows with matchType = NULL: ${nullMatch}`)
console.log('  ⇒ 🔴 a Postgres UNIQUE index treats NULLs as DISTINCT, so a null matchType would')
console.log('    escape the constraint entirely. If this is non-zero the key needs COALESCE or a')
console.log('    NOT NULL default — the same trap AdsHarvestPolicy.scopeId avoided with a sentinel.')

// ── 4 · the write pre-flight ─────────────────────────────────────────────────
console.log('\n\n═══ 4 · would the gate actually ALLOW these writes? ═══\n')
const { checkAdsWriteGate } = await import('../src/services/advertising/ads-write-gate.js')
console.log(`${pad('term', 30)} ${pad('mkt', 4)} ${pad('bid', 8)} ${pad('KEYWORD write', 30)} negative (campaign scope)`)
for (const r of page.rows) {
  const cpc = r.metrics.cpcCents ?? 50
  const camp = r.campaign
  const kw = await checkAdsWriteGate({ marketplace: r.market, payloadValueCents: Math.round(cpc), campaignId: camp.id ?? undefined } as never)
  const neg = await checkAdsWriteGate({
    marketplace: r.market, payloadValueCents: 0, campaignId: camp.id ?? undefined,
    isNegation: true, keywordText: r.term,
  } as never)
  const f = (g: { allowed: boolean; reason?: string; deniedAt?: string }) =>
    g.allowed ? '✅ allowed' : `🔴 ${g.deniedAt}: ${String(g.reason ?? '').slice(0, 40)}`
  console.log(`${pad(r.term, 30)} ${pad(r.market, 4)} ${pad(eur(cpc), 8)} ${pad(f(kw as never), 30)} ${f(neg as never)}`)
}

// the protected terms, which refuse the NEGATIVE half
console.log('\nprotected terms (AdKeywordProtection WHITELIST) — these refuse the negate half:')
const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, isPrefix: true, matchType: true, marketplace: true, reason: true } })
for (const p of prot) console.log(`  ${pad(p.term, 24)} ${pad(p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT'), 9)} ${pad(p.marketplace ?? 'all markets', 12)} ${String(p.reason ?? '').slice(0, 46)}`)

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
