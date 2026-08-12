/**
 * _sov0-states.mts — the four blank-states, on real prod rows, in the period each view renders.
 *
 * `_sov0-probe.mts` established the gate and the denominator. This one answers the question that
 * decides the grid: for each candidate POPULATION rule, how many rows land in each state, and
 * which named row demonstrates each.
 *
 * 🔴 It exists because the brief's fixture list does not survive a re-read. The brief names four
 * "real IT zeros (impressionsTotal > 0, ours 0)" in period 2026-07-12. Measured: the gate chooses
 * 2026-07-19 for IT, and two of the four (`givi`, `giacca moto protezioni livello 3`) carry a
 * NON-zero brand count once our ASIN rows are summed. So the fixtures are re-derived here rather
 * than trusted.
 *
 * NO WRITES.
 * Run from apps/api: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_sov0-states.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { resolveScope, chooseViewPeriod, KT_LOOKBACK_DAYS, type KtScopeGraph } from '../src/services/advertising/keyword-tracker.service.js'
import { classifyBranded, normTerm } from '../src/services/advertising/keyword-watchlist.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
const ASIN_RE = /^b0[a-z0-9]{8}$/i

async function chosenFor(market: string) {
  const g = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: market }, _count: { _all: true } })
  return chooseViewPeriod(g.map((p) => ({ start: p.startDate, rows: p._count._all })))
}

async function main() {
  const protections = await prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' }, select: { term: true, matchType: true, isPrefix: true, marketplace: true },
  })

  // ── 1 · real zeros, per market, IN THE PERIOD THAT MARKET RENDERS ────────
  h('1 · "we hold none" — Σ brand = 0 with a real market total, in the chosen period')
  for (const m of MARKETS) {
    const chosen = await chosenFor(m)
    if (!chosen.start) { line(`${m}: no period`); continue }
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, startDate: chosen.start },
      select: { searchQuery: true, asin: true, impressionsTotal: true, impressionsBrand: true, searchQueryVolume: true, searchQueryRank: true },
    })
    const agg = new Map<string, { total: number; brand: number; vol: number; rank: number | null; asins: number }>()
    for (const r of rows) {
      const a = agg.get(r.searchQuery) ?? { total: 0, brand: 0, vol: 0, rank: null, asins: 0 }
      a.total = Math.max(a.total, r.impressionsTotal); a.brand += r.impressionsBrand
      a.vol = Math.max(a.vol, r.searchQueryVolume); a.rank = a.rank == null ? r.searchQueryRank : Math.min(a.rank, r.searchQueryRank ?? 1e9)
      a.asins++; agg.set(r.searchQuery, a)
    }
    const zeros = [...agg.entries()].filter(([, a]) => a.total > 0 && a.brand === 0).sort((x, y) => y[1].total - x[1].total)
    const noTotal = [...agg.entries()].filter(([, a]) => a.total === 0)
    line(`${m} ${d10(chosen.start)}: ${agg.size} queries · REAL ZEROS ${zeros.length} · impressionsTotal=0 (the tie share() hides) ${noTotal.length}`)
    for (const [q, a] of zeros.slice(0, 6)) line(`    ZERO "${q}" total=${a.total} vol=${a.vol} rank=${a.rank} ourAsinRows=${a.asins}`)
  }

  // ── 2 · ASIN-shaped queries in SQP, ALL-TIME (the ?kind= filter's basis) ─
  h('2 · ASIN-shaped queries in SearchQueryPerformance, all-time')
  for (const m of MARKETS) {
    const qs = await prisma.searchQueryPerformance.findMany({ where: { marketplace: m }, select: { searchQuery: true }, distinct: ['searchQuery'] })
    const asinish = qs.filter((r) => ASIN_RE.test(r.searchQuery))
    line(`${m}: ${qs.length} distinct queries all-time · ASIN-shaped ${asinish.length}${asinish.length ? ` — e.g. ${asinish.slice(0, 3).map((r) => r.searchQuery).join(', ')}` : ''}`)
  }
  const paid = await prisma.amazonAdsSearchTerm.findMany({ select: { query: true }, distinct: ['query'] })
  line(`(for contrast, the AD side — AmazonAdsSearchTerm: ${paid.length} distinct queries, ASIN-shaped ${paid.filter((r) => ASIN_RE.test(r.query)).length})`)

  // ── 3 · branded queries in the chosen period ────────────────────────────
  h('3 · branded queries (classifyBranded, the SAME classifier KT.2 stores with)')
  for (const m of MARKETS) {
    const chosen = await chosenFor(m)
    if (!chosen.start) continue
    const qs = await prisma.searchQueryPerformance.findMany({ where: { marketplace: m, startDate: chosen.start }, select: { searchQuery: true }, distinct: ['searchQuery'] })
    const branded = qs.filter((r) => classifyBranded(r.searchQuery, m, protections))
    line(`${m} ${d10(chosen.start)}: ${qs.length} queries · branded ${branded.length} (${((branded.length / Math.max(1, qs.length)) * 100).toFixed(2)}%)${branded.length ? ` — ${branded.slice(0, 6).map((r) => `"${r.searchQuery}"`).join(', ')}` : ''}`)
  }

  // ── 4 · the watchlist, read as a MARKET view filter ─────────────────────
  h('4 · watchlists — the three states a list produces against the chosen period')
  const lists = await prisma.keywordWatchlist.findMany({
    select: { id: true, marketplace: true, name: true, isDefault: true, source: true, _count: { select: { terms: true } } },
    orderBy: [{ marketplace: 'asc' }, { isDefault: 'desc' }],
  })
  for (const l of lists) line(`  ${l.marketplace} "${l.name}" ${l._count.terms} terms · default=${l.isDefault} · source=${l.source} · ${l.id}`)
  for (const m of MARKETS) {
    const l = lists.find((x) => x.marketplace === m && x.isDefault) ?? lists.find((x) => x.marketplace === m)
    if (!l) { line(`${m}: no watchlist`); continue }
    const chosen = await chosenFor(m)
    const terms = await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: l.id }, select: { term: true, isBranded: true } })
    const wanted = [...new Set(terms.map((t) => normTerm(t.term)))]
    const inPeriod = chosen.start
      ? new Set((await prisma.searchQueryPerformance.findMany({
        where: { marketplace: m, startDate: chosen.start, searchQuery: { in: wanted } }, select: { searchQuery: true }, distinct: ['searchQuery'],
      })).map((r) => normTerm(r.searchQuery)))
      : new Set<string>()
    const everSeen = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'], where: { marketplace: m, searchQuery: { in: wanted } }, _max: { startDate: true },
    })
    const everMap = new Map(everSeen.map((r) => [normTerm(r.searchQuery), r._max.startDate]))
    const measured = wanted.filter((t) => inPeriod.has(t))
    const noRow = wanted.filter((t) => !inPeriod.has(t) && everMap.has(t))
    const never = wanted.filter((t) => !inPeriod.has(t) && !everMap.has(t))
    line(`${m} "${l.name}" (${wanted.length}) vs ${d10(chosen.start)}: measured ${measured.length} · no-row-this-period ${noRow.length} · never-measured ${never.length}`)
    if (noRow.length) line(`    NO-ROW e.g. ${noRow.slice(0, 4).map((t) => `"${t}" (last seen ${d10(everMap.get(t))})`).join(', ')}`)
    if (never.length) line(`    NEVER  e.g. ${never.slice(0, 4).map((t) => `"${t}"`).join(', ')}`)
  }

  // ── 5 · not-covered: the market has the query, our SCOPED ASINs do not ──
  h('5 · "not covered" — market has the query this period, the scope\'s ASINs have no row')
  const [campaigns, adsAll] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true } }),
    prisma.adProductAd.findMany({ where: { asin: { not: null } }, select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } } }),
  ])
  const productIds = [...new Set(adsAll.map((a) => a.productId).filter((x): x is string => !!x))]
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true } })
  const graph: KtScopeGraph = {
    campaigns: campaigns.map((c) => ({ ...c, status: String(c.status) })),
    ads: adsAll.filter((a) => a.adGroup?.campaignId).map((a) => ({ productId: a.productId, asin: a.asin, campaignId: a.adGroup!.campaignId })),
    products,
  }
  const itChosen = await chosenFor('IT')
  const itCampaigns = campaigns.filter((c) => c.marketplace === 'IT' && String(c.status) !== 'ARCHIVED')
  const pfIds = [...new Set(itCampaigns.map((c) => c.portfolioId).filter((x): x is string => !!x))]
  const marketQueries = itChosen.start
    ? new Set((await prisma.searchQueryPerformance.findMany({ where: { marketplace: 'IT', startDate: itChosen.start }, select: { searchQuery: true }, distinct: ['searchQuery'] })).map((r) => r.searchQuery))
    : new Set<string>()
  for (const pf of pfIds.slice(0, 4)) {
    const sc = resolveScope(graph, { market: 'IT', portfolio: pf })
    const scoped = itChosen.start && sc.asins.length
      ? new Set((await prisma.searchQueryPerformance.findMany({ where: { marketplace: 'IT', startDate: itChosen.start, asin: { in: sc.asins } }, select: { searchQuery: true }, distinct: ['searchQuery'] })).map((r) => r.searchQuery))
      : new Set<string>()
    const notCovered = [...marketQueries].filter((q) => !scoped.has(q))
    line(`portfolio ${pf}: ${sc.campaignIds.length} campaigns · ${sc.asins.length} ASINs · market ${marketQueries.size} queries → measured ${scoped.size} · NOT COVERED ${notCovered.length}${notCovered.length ? ` — e.g. "${notCovered[0]}"` : ''}`)
  }
  // a campaign with a SMALL ASIN set makes the state unmissable
  for (const c of itCampaigns.slice(0, 60)) {
    const sc = resolveScope(graph, { market: 'IT', campaign: c.id })
    if (sc.asins.length === 0 || sc.asins.length > 4) continue
    const scoped = itChosen.start
      ? new Set((await prisma.searchQueryPerformance.findMany({ where: { marketplace: 'IT', startDate: itChosen.start, asin: { in: sc.asins } }, select: { searchQuery: true }, distinct: ['searchQuery'] })).map((r) => r.searchQuery))
      : new Set<string>()
    line(`campaign "${c.name}" (${c.id}): ${sc.asins.length} ASINs → measured ${scoped.size} of ${marketQueries.size} · NOT COVERED ${marketQueries.size - scoped.size}`)
    break
  }

  // ── 6 · population sizes under the two candidate rules ──────────────────
  h('6 · population: chosen period only, vs a 42-day union')
  for (const m of MARKETS) {
    const chosen = await chosenFor(m)
    const since = new Date(Date.now() - KT_LOOKBACK_DAYS * 86_400_000)
    const [inPeriod, in42] = await Promise.all([
      chosen.start ? prisma.searchQueryPerformance.findMany({ where: { marketplace: m, startDate: chosen.start }, select: { searchQuery: true }, distinct: ['searchQuery'] }) : Promise.resolve([]),
      prisma.searchQueryPerformance.findMany({ where: { marketplace: m, startDate: { gte: since } }, select: { searchQuery: true }, distinct: ['searchQuery'] }),
    ])
    const blankPct = in42.length ? (((in42.length - inPeriod.length) / in42.length) * 100).toFixed(0) : '0'
    line(`${m}: chosen-period ${inPeriod.length} rows, 0 blank · 42d union ${in42.length} rows, ${in42.length - inPeriod.length} blank (${blankPct}%)`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
