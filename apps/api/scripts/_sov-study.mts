/**
 * SOV — Share of Voice tab study. READ-ONLY.
 *
 * The tab's headline column is called "Share of Voice". The service that computes it
 * (ads-impression-share.service.ts) defines it as:
 *
 *     sovPct = this query's impressions ÷ ALL OUR TRACKED IMPRESSIONS
 *
 * That is a share of OURSELVES — what fraction of our own ad traffic this query accounts for.
 * Share of voice, everywhere else in the industry, means our impressions ÷ the MARKET's
 * impressions for that query. This script measures how far apart the two numbers are, using
 * Brand Analytics SQP (`impressionsBrand / impressionsTotal`) as the real figure.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { analyzeShareOfVoice } = await import('../src/services/advertising/ads-impression-share.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const p2 = (f: number) => `${(f * 100).toFixed(2)}%`

console.log('\n═══ SOV — Share of Voice tab ═══\n')

// ── 1. what the tab actually renders ──────────────────────────────────────────
const res = await analyzeShareOfVoice({ windowDays: 30, limit: 300 })
console.log(`window ${res.windowDays}d · ${int(res.queries)} queries · ${int(res.totalImpressions)} total impressions`)
console.log(`flags: cannibalized=${res.summary.cannibalizedQueries} · outbid=${res.summary.outbidQueries} · weak-relevance=${res.summary.weakRelevanceQueries}`)
console.log(`\nthe tab's top 10 rows, exactly as rendered:`)
console.log(`${pad('query', 40)} ${pad('impr', 9)} ${pad('"SOV"', 8)} ${pad('topCampSh', 10)} camps`)
for (const r of res.rows.slice(0, 10)) {
  console.log(`${pad(r.query, 40)} ${pad(int(r.impressions), 9)} ${pad(p2(r.sovPct), 8)} ${pad(p2(r.topCampaignSharePct), 10)} ${r.campaignCount}`)
}
const sovSum = res.rows.reduce((a, r) => a + r.sovPct, 0)
console.log(`\n  Σ "SOV" over the ${res.rows.length} rows shown = ${p2(sovSum)}`)
console.log(`  ← a real share of voice does NOT sum to 100% across queries. A composition does.`)

// ── 2. the same queries, measured against the MARKET ──────────────────────────
const sqp = await prisma.searchQueryPerformance.findMany({
  select: { searchQuery: true, marketplace: true, asin: true, impressionsBrand: true, impressionsTotal: true, impressionShare: true, searchQueryVolume: true, startDate: true },
})
// best (highest-share) ASIN per query, latest week that query appears in
const bestByQuery = new Map<string, { share: number; brand: number; total: number; mkt: string; vol: number; when: Date }>()
for (const r of sqp) {
  const k = r.searchQuery.trim().toLowerCase()
  const cur = bestByQuery.get(k)
  if (!cur || r.startDate > cur.when || (r.startDate.getTime() === cur.when.getTime() && Number(r.impressionShare) > cur.share)) {
    bestByQuery.set(k, { share: Number(r.impressionShare), brand: r.impressionsBrand, total: r.impressionsTotal, mkt: r.marketplace, vol: r.searchQueryVolume, when: r.startDate })
  }
}
console.log(`\nSQP queries available for comparison: ${int(bestByQuery.size)}`)

const overlap = res.rows
  .map((r) => ({ r, s: bestByQuery.get(r.query.trim().toLowerCase()) }))
  .filter((x): x is { r: typeof res.rows[number]; s: NonNullable<ReturnType<typeof bestByQuery.get>> } => !!x.s)
console.log(`queries on BOTH the tab and SQP        : ${int(overlap.length)} of ${res.rows.length} shown`)

if (overlap.length) {
  console.log(`\n── the same query, both numbers ──`)
  console.log(`${pad('query', 34)} ${pad('mkt', 4)} ${pad('our impr', 9)} ${pad('tab "SOV"', 10)} ${pad('REAL share', 11)} ${pad('mkt impr', 10)} overstated by`)
  for (const { r, s } of overlap.sort((a, b) => b.r.impressions - a.r.impressions).slice(0, 15)) {
    const factor = s.share > 0 ? r.sovPct / s.share : Infinity
    console.log(`${pad(r.query, 34)} ${pad(s.mkt, 4)} ${pad(int(r.impressions), 9)} ${pad(p2(r.sovPct), 10)} ${pad(p2(s.share), 11)} ${pad(int(s.total), 10)} ${Number.isFinite(factor) ? `${factor.toFixed(0)}×` : '∞'}`)
  }
  const meanTab = overlap.reduce((a, x) => a + x.r.sovPct, 0) / overlap.length
  const meanReal = overlap.reduce((a, x) => a + x.s.share, 0) / overlap.length
  console.log(`\n  mean of the tab's "Share of Voice" : ${p2(meanTab)}`)
  console.log(`  mean of the REAL market share      : ${p2(meanReal)}`)
  console.log(`  the tab overstates by a factor of  : ${(meanTab / Math.max(1e-9, meanReal)).toFixed(0)}×`)
}

// ── 3. the rule path ──────────────────────────────────────────────────────────
const sovRules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', trigger: 'SOV_BID' },
  select: { name: true, enabled: true, autonomyLevel: true, evaluationCount: true, matchCount: true, executionCount: true },
})
console.log(`\nRules on trigger SOV_BID: ${sovRules.length}`)
for (const r of sovRules) console.log(`  ${pad(r.name, 44)} enabled=${r.enabled} level=${r.autonomyLevel} evals=${r.evaluationCount} matches=${r.matchCount} execs=${r.executionCount}`)

// ── 4. coverage: how much of the market do we even see? ───────────────────────
const paidQ = await prisma.amazonAdsSearchTerm.findMany({ distinct: ['query'], select: { query: true }, where: { impressions: { gt: 0 } } })
const paidSet = new Set(paidQ.map((q) => q.query.trim().toLowerCase()))
let inBoth = 0
for (const k of bestByQuery.keys()) if (paidSet.has(k)) inBoth++
console.log(`\n── coverage ──`)
console.log(`  queries we PAID on (search-term report)   : ${int(paidSet.size)}`)
console.log(`  queries the MARKET data knows (SQP)       : ${int(bestByQuery.size)}`)
console.log(`  in both                                   : ${int(inBoth)}`)
console.log(`  in SQP but we never advertised on         : ${int(bestByQuery.size - inBoth)}  ← demand we are not bidding on`)

await prisma.$disconnect()
