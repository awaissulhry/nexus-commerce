/**
 * SOV page study — part A. READ-ONLY.
 *
 * The tab-specific mechanics I actively doubt, none of them measured by _sov-study.mts:
 *   1. analyzeShareOfVoice aggregates by `query` ALONE — no marketplace in the key. Does the
 *      same query string occur in more than one market, and how much volume does that merge?
 *   2. What is the market composition of the 300 rows the tab renders?
 *   3. The two flags: how are they distributed, and which queries can NEVER be flagged?
 *   4. Is AdTarget.spendCents/salesCents/ordersCount populated? buildSovBidContexts reads them.
 *   5. How many SOV_BID contexts would the evaluator actually emit, and how many of those
 *      attach a query's SOV from a DIFFERENT marketplace than the target's campaign?
 *
 * No writes. Every zero is printed with the denominator that produced it.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`

console.log('\n═══ SOV page study — A: the tab\'s own mechanics ═══\n')

// ── 1. does the service merge markets? ────────────────────────────────────────
const since = new Date(Date.now() - 30 * 86_400_000)
const terms = await prisma.amazonAdsSearchTerm.findMany({
  where: { date: { gte: since } },
  select: { query: true, marketplace: true, campaignId: true, impressions: true, clicks: true, costMicros: true, currencyCode: true },
})
console.log(`AmazonAdsSearchTerm rows in the tab's 30d window: ${int(terms.length)}`)

const byQuery = new Map<string, Map<string, number>>() // query -> marketplace -> impressions
let totalImpr = 0
for (const t of terms) {
  const q = (t.query || '').trim()
  if (!q) continue
  const m = byQuery.get(q) ?? new Map<string, number>()
  m.set(t.marketplace, (m.get(t.marketplace) ?? 0) + t.impressions)
  byQuery.set(q, m)
  totalImpr += t.impressions
}
const multi = [...byQuery.entries()].filter(([, m]) => m.size > 1)
const multiImpr = multi.reduce((a, [, m]) => a + [...m.values()].reduce((x, y) => x + y, 0), 0)
console.log(`distinct query strings                          : ${int(byQuery.size)}`)
console.log(`  …appearing in ≥2 marketplaces                 : ${int(multi.length)}  (${p2(multi.length / Math.max(1, byQuery.size))} of queries)`)
console.log(`  impressions inside those merged rows          : ${int(multiImpr)} of ${int(totalImpr)} = ${p2(multiImpr / Math.max(1, totalImpr))}`)
if (multi.length) {
  console.log(`\n  the biggest merged rows (ONE row on the tab, N markets underneath):`)
  console.log(`  ${pad('query', 40)} ${pad('total impr', 11)} split`)
  for (const [q, m] of multi.sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)).slice(0, 12)) {
    const tot = [...m.values()].reduce((x, y) => x + y, 0)
    const split = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([mk, v]) => `${mk} ${int(v)}`).join(' · ')
    console.log(`  ${pad(q, 40)} ${pad(int(tot), 11)} ${split}`)
  }
}

// ── 2. market composition of what the tab renders ─────────────────────────────
const res = await analyzeShareOfVoice({ windowDays: 30, limit: 300 })
const shownMarkets = new Map<string, number>()
for (const r of res.rows) {
  const m = byQuery.get(r.query)
  if (!m) continue
  const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0]
  shownMarkets.set(top[0], (shownMarkets.get(top[0]) ?? 0) + 1)
}
console.log(`\nthe 300 rendered rows, by dominant marketplace   :`)
for (const [mk, n] of [...shownMarkets.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(mk, 6)} ${int(n)} rows`)
const shownImpr = res.rows.reduce((a, r) => a + r.impressions, 0)
console.log(`\ntotal queries in window : ${int(res.queries)} — the tab renders 300 (${p2(300 / Math.max(1, res.queries))})`)
console.log(`impressions covered     : ${int(shownImpr)} of ${int(res.totalImpressions)} = ${p2(shownImpr / Math.max(1, res.totalImpressions))}`)
console.log(`  → the "Share of Voice" column sums to ${p2(res.rows.reduce((a, r) => a + r.sovPct, 0))} on screen because the tail is cut, not because it is a share.`)

// ── 3. the two flags, and who can never be flagged ────────────────────────────
const full = await analyzeShareOfVoice({ windowDays: 30, limit: 100000 })
let noClicks = 0, withClicks = 0, under50 = 0
for (const r of full.rows) { if (r.clicks === 0) noClicks++; else withClicks++; if (r.impressions < 50) under50++ }
console.log(`\n── flags, over ALL ${int(full.rows.length)} queries (not just the 300 shown) ──`)
console.log(`outbid          : ${int(full.summary.outbidQueries)}`)
console.log(`weak-relevance  : ${int(full.summary.weakRelevanceQueries)}`)
console.log(`cannibalized    : ${int(full.summary.cannibalizedQueries)}`)
console.log(`queries with 0 clicks : ${int(noClicks)} (${p2(noClicks / Math.max(1, full.rows.length))}) — cpcCents is null for these,`)
console.log(`  so the outbid test (cpc > 1.25 × median) can NEVER fire on them. ${int(withClicks)} queries are eligible;`)
console.log(`  ${int(full.summary.outbidQueries)} of those ${int(withClicks)} are flagged = ${p2(full.summary.outbidQueries / Math.max(1, withClicks))}.`)
console.log(`queries under 50 impressions : ${int(under50)} — structurally excluded from weak-relevance.`)
const flaggedBoth = full.rows.filter((r) => {
  const eligibleWeak = r.impressions >= 50
  return r.flag === 'outbid' && eligibleWeak
}).length
console.log(`rows flagged 'outbid' that also clear weak-relevance's impression gate: ${int(flaggedBoth)} — the flag is`)
console.log(`  single-valued, so any second condition on the same row is invisible.`)
const meanImpr = totalImpr / Math.max(1, byQuery.size)
const sortedImpr = full.rows.map((r) => r.impressions).sort((a, b) => a - b)
const medImpr = sortedImpr[Math.floor(sortedImpr.length / 2)] ?? 0
console.log(`\nthe outbid heuristic's impression bar is the MEAN (${int(Math.round(meanImpr))}), not the median (${int(medImpr)}).`)
console.log(`  ${int(full.rows.filter((r) => r.impressions < meanImpr).length)} of ${int(full.rows.length)} queries sit below the mean — the bar excludes almost nobody.`)

// ── 4. is AdTarget populated? buildSovBidContexts reads these columns ─────────
const tgTotal = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
const tgSpend = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, spendCents: { gt: 0 } } })
const tgSales = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, salesCents: { gt: 0 } } })
const tgOrders = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, ordersCount: { gt: 0 } } })
const tgImpr = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, impressions: { gt: 0 } } })
console.log(`\n── AdTarget columns the SOV_BID context hands to a rule ──`)
console.log(`positive KEYWORD targets     : ${int(tgTotal)}`)
console.log(`  with spendCents  > 0       : ${int(tgSpend)}`)
console.log(`  with salesCents  > 0       : ${int(tgSales)}`)
console.log(`  with ordersCount > 0       : ${int(tgOrders)}`)
console.log(`  with impressions > 0       : ${int(tgImpr)}`)
console.log(`  → acos in the context is spendCents/salesCents; with salesCents 0 the builder yields acos = 0.`)

// ── 5. what buildSovBidContexts would actually emit, and its market join ──────
const sovByQuery = new Map(full.rows.map((r) => [r.query.trim().toLowerCase(), r]))
const targets = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { id: true, expressionValue: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
  take: 3000,
})
let matched = 0, mismatched = 0, sameMarket = 0, unknownMarket = 0
const mismatchSamples: string[] = []
for (const t of targets) {
  const key = (t.expressionValue ?? '').trim().toLowerCase()
  if (!key || !sovByQuery.has(key)) continue
  matched++
  const tm = t.adGroup?.campaign?.marketplace ?? null
  const src = byQuery.get(sovByQuery.get(key)!.query)
  if (!tm || !src) { unknownMarket++; continue }
  if (src.has(tm)) {
    sameMarket++
    if (src.size > 1) {
      // the SOV number attached is the SUM across markets, not this market's
      if (mismatchSamples.length < 8) mismatchSamples.push(`${pad(key, 34)} target ${tm} · SOV summed over ${[...src.keys()].join('+')}`)
    }
  } else {
    mismatched++
    if (mismatchSamples.length < 8) mismatchSamples.push(`${pad(key, 34)} target ${tm} · SOV came from ${[...src.keys()].join('+')} ONLY`)
  }
}
console.log(`\n── SOV_BID contexts the evaluator would emit ──`)
console.log(`positive KEYWORD targets scanned (take 3000) : ${int(targets.length)}`)
console.log(`  matched a SOV query by lowercased text     : ${int(matched)}  ← contexts emitted`)
console.log(`  target's market IS among the SOV row's     : ${int(sameMarket)}`)
console.log(`  target's market is NOT among them          : ${int(mismatched)}  ← the rule reads another country's number`)
console.log(`  target has no resolvable marketplace       : ${int(unknownMarket)}`)
if (mismatchSamples.length) { console.log(`\n  samples:`); for (const s of mismatchSamples) console.log(`  ${s}`) }

const sovRules = await prisma.automationRule.findMany({ where: { trigger: 'SOV_BID' }, select: { id: true, name: true, enabled: true, autonomyLevel: true } })
console.log(`\nAutomationRule rows on trigger SOV_BID : ${sovRules.length}`)
for (const r of sovRules) console.log(`  ${r.id} ${r.name} enabled=${r.enabled} autonomy=${r.autonomyLevel}`)

// ── 6. currency: the service sums costMicros across markets into one CPC ─────
const curr = new Map<string, number>()
for (const t of terms) curr.set(t.currencyCode ?? '∅', (curr.get(t.currencyCode ?? '∅') ?? 0) + 1)
console.log(`\ncurrencyCode across the window's search-term rows: ${[...curr.entries()].map(([c, n]) => `${c}=${int(n)}`).join(' · ')}`)
console.log(`  → the median-CPC heuristic sums cost across every row; more than one currency here would make it meaningless.`)

await prisma.$disconnect()
console.log('\n═══ end A ═══\n')
