/**
 * KT — Keyword Tracker tab study. READ-ONLY: counts and shapes only, no writes.
 *
 * The tab claims to show, per tracked keyword: Search Volume · Organic Rank · Sponsored Rank ·
 * Rank Δ. Amazon's Ads API exposes none of those four. So the study's first job is to establish
 * what this account actually holds that bears on "where do we rank", and how far each source is
 * from the four columns the UI promises.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ KT — Keyword Tracker: what data actually exists ═══\n')

// ── 1. the table the tab reads ────────────────────────────────────────────────
const krCount = await prisma.keywordRank.count()
console.log(`KeywordRank (the tab's ONLY source)      : ${int(krCount)} rows`)
if (krCount) {
  const bySource = await prisma.keywordRank.groupBy({ by: ['source'], _count: { _all: true } })
  for (const s of bySource) console.log(`    source=${s.source}: ${s._count._all}`)
}

// ── 2. is any rule wired to it? ───────────────────────────────────────────────
const rankRules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', trigger: 'KEYWORD_RANK_BID' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, evaluationCount: true, matchCount: true, lastEvaluatedAt: true },
})
console.log(`\nRules on trigger KEYWORD_RANK_BID        : ${rankRules.length}`)
for (const r of rankRules) {
  console.log(`    ${pad(r.name, 44)} enabled=${r.enabled} level=${r.autonomyLevel} evals=${r.evaluationCount} matches=${r.matchCount} last=${r.lastEvaluatedAt?.toISOString().slice(0, 10) ?? 'never'}`)
}

// ── 3. what COULD be tracked — the keywords we actually bid on ────────────────
const kwTargets = await prisma.adTarget.groupBy({
  by: ['expressionValue'],
  where: { kind: 'KEYWORD', isNegative: false },
  _count: { _all: true },
})
const negTargets = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: true } })
console.log(`\nPositive KEYWORD targets (distinct text) : ${int(kwTargets.length)}`)
console.log(`Negative KEYWORD targets                 : ${int(negTargets)}`)

// ── 4. the rank PROXIES that do have data ─────────────────────────────────────
console.log('\n── proxies for "where do we rank", and how complete each is ──')

const sqpCount = await prisma.searchQueryPerformance.count()
console.log(`SearchQueryPerformance (Brand Analytics) : ${int(sqpCount)} rows`)
if (sqpCount) {
  const [distinctQ, withRank, withAsin, periods, mkts, range] = await Promise.all([
    prisma.searchQueryPerformance.findMany({ distinct: ['searchQuery'], select: { searchQuery: true } }).then((r) => r.length),
    prisma.searchQueryPerformance.count({ where: { searchQueryRank: { not: null } } }),
    prisma.searchQueryPerformance.count({ where: { asin: { not: null } } }),
    prisma.searchQueryPerformance.groupBy({ by: ['reportPeriod'], _count: { _all: true } }),
    prisma.searchQueryPerformance.groupBy({ by: ['marketplace'], _count: { _all: true } }),
    prisma.searchQueryPerformance.aggregate({ _min: { startDate: true }, _max: { startDate: true } }),
  ])
  console.log(`    distinct search queries              : ${int(distinctQ)}`)
  console.log(`    rows carrying searchQueryRank        : ${int(withRank)}  ← market popularity rank, NOT our position`)
  console.log(`    rows scoped to one of our ASINs      : ${int(withAsin)}`)
  console.log(`    periods                              : ${periods.map((p) => `${p.reportPeriod}=${p._count._all}`).join(' · ')}`)
  console.log(`    marketplaces                         : ${mkts.map((m) => `${m.marketplace}=${m._count._all}`).join(' · ')}`)
  console.log(`    window                               : ${range._min.startDate?.toISOString().slice(0, 10)} → ${range._max.startDate?.toISOString().slice(0, 10)}`)

  // The one SQP figure that is a genuine position proxy: our share of the impressions
  // the whole market got for a query. High share ≈ we are visible; it is not a rank.
  const top = await prisma.searchQueryPerformance.findMany({
    where: { asin: null, impressionsTotal: { gt: 0 } },
    orderBy: [{ searchQueryVolume: 'desc' }],
    select: { searchQuery: true, marketplace: true, searchQueryVolume: true, searchQueryRank: true, impressionShare: true, clickShare: true, purchaseShare: true },
    take: 12,
  })
  if (top.length) {
    console.log(`\n    top queries by market volume (brand-level rows):`)
    console.log(`    ${pad('query', 38)} ${pad('mkt', 4)} ${pad('volume', 9)} ${pad('mktRank', 8)} ${pad('imprShare', 10)} ${pad('clickShare', 11)} purchShare`)
    for (const t of top) {
      console.log(`    ${pad(t.searchQuery, 38)} ${pad(t.marketplace, 4)} ${pad(int(t.searchQueryVolume), 9)} ${pad(String(t.searchQueryRank ?? '—'), 8)} ${pad(`${(Number(t.impressionShare) * 100).toFixed(2)}%`, 10)} ${pad(`${(Number(t.clickShare) * 100).toFixed(2)}%`, 11)} ${(Number(t.purchaseShare) * 100).toFixed(2)}%`)
    }
  }
}

// Sponsored position proxy — Amazon's own top-of-search impression share.
const tos = await prisma.amazonAdsPlacementReport.aggregate({
  where: { topOfSearchIS: { not: null } },
  _count: { _all: true }, _max: { date: true }, _min: { date: true },
})
console.log(`\nAmazonAdsPlacementReport w/ topOfSearchIS : ${int(tos._count._all)} campaign-days  (${tos._min.date?.toISOString().slice(0, 10)} → ${tos._max.date?.toISOString().slice(0, 10)})`)
console.log(`    ← the closest thing to a SPONSORED rank we have, and it is per CAMPAIGN, not per keyword`)

// Our own paid search terms — the query universe we could track.
const stAgg = await prisma.amazonAdsSearchTerm.aggregate({ _count: { _all: true }, _min: { date: true }, _max: { date: true } })
const stQ = await prisma.amazonAdsSearchTerm.findMany({ distinct: ['query'], select: { query: true }, where: { impressions: { gt: 0 } } })
console.log(`\nAmazonAdsSearchTerm                      : ${int(stAgg._count._all)} rows · ${int(stQ.length)} distinct queries  (${stAgg._min.date?.toISOString().slice(0, 10)} → ${stAgg._max.date?.toISOString().slice(0, 10)})`)

// Keyword coverage sets — check whether an existing feature already tracks a keyword list.
const [covSets, covTerms] = await Promise.all([
  prisma.keywordCoverageSet.count().catch(() => -1),
  prisma.keywordCoverageTerm.count().catch(() => -1),
])
console.log(`KeywordCoverageSet / Term                : ${covSets} sets · ${covTerms} terms`)

// Protected terms — the curated list that already names what matters.
const prot = await prisma.adKeywordProtection.findMany({ select: { term: true, mode: true, marketplace: true } })
console.log(`\nAdKeywordProtection (a curated list already exists): ${prot.length}`)
for (const p of prot) console.log(`    ${p.mode === 'WHITELIST' ? 'never-negate' : 'always-negate'}  ${p.term}${p.marketplace ? ` [${p.marketplace}]` : ''}`)

await prisma.$disconnect()
