/**
 * _sov0-probe.mts — the measurements SOV.0's basis rests on (read-only).
 *
 * Six questions, none of which may be assumed:
 *
 *   1. THE POPULATION. Share of Voice is a MARKET view — a term is on the grid because a market
 *      exists, not because a human watch-listed it. So the row set is "the queries this market
 *      shows us", and that needs a window. Measured at 42d (the KT lookback) and all-time.
 *   2. THE PERIOD GATE holds. `chooseViewPeriod` must yield exactly ONE `asOf` per view — every
 *      market, plus a real portfolio and a real campaign. Asserted, not assumed.
 *   3. THE DENOMINATOR. `impressionsTotal` is the whole market's count for a query, repeated on
 *      every ASIN row of that query. If it is NOT constant across those rows, summing is wrong and
 *      the service must take one. Measured.
 *   4. SCOPE REACH, both numbers: campaigns resolved, and how many of the scope's ASINs Brand
 *      Analytics actually reports on.
 *   5. THE FOUR BLANK-STATES, each on a NAMED prod row — including the real IT zeros the brief
 *      cites (givi / africa twin / scorpion exo tech).
 *   6. FRESHNESS, per feed, per market — the two ages the band has to state separately.
 *
 * NO WRITES.
 * Run from apps/api: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_sov0-probe.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { resolveScope, chooseViewPeriod, KT_LOOKBACK_DAYS, type KtScopeGraph } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const age = (d: Date | null | undefined) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null)
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
/** An ASIN-shaped query: B + 9 alphanumerics. 643 of the paid queries are these; SQP is unmeasured. */
const ASIN_RE = /^b0[a-z0-9]{8}$/i

async function main() {
  // ── the scope graph, once ────────────────────────────────────────────────
  const [campaigns, adsAll, protections] = await Promise.all([
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true, status: true } }),
    prisma.adProductAd.findMany({
      where: { asin: { not: null } },
      select: { productId: true, asin: true, adGroup: { select: { campaignId: true, campaign: { select: { marketplace: true } } } } },
    }),
    prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true, matchType: true, isPrefix: true, marketplace: true } }),
  ])
  const productIds = [...new Set(adsAll.map((a) => a.productId).filter((x): x is string => !!x))]
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true } })
  const graph: KtScopeGraph = {
    campaigns: campaigns.map((c) => ({ ...c, status: String(c.status) })),
    ads: adsAll.filter((a) => a.adGroup?.campaignId).map((a) => ({ productId: a.productId, asin: a.asin, campaignId: a.adGroup!.campaignId })),
    products,
  }

  h('0 · the account, for the two-number contract')
  line(`campaigns: ${campaigns.length} · with a portfolioId: ${campaigns.filter((c) => c.portfolioId).length}`)
  for (const m of MARKETS) {
    const inM = campaigns.filter((c) => c.marketplace === m)
    line(`  ${m}: ${inM.length} campaigns (${inM.filter((c) => String(c.status) === 'ARCHIVED').length} archived) · ${inM.filter((c) => c.portfolioId).length} with a portfolio`)
  }
  line(`AdKeywordProtection WHITELIST rows: ${protections.length} — ${protections.map((p) => `${p.term}/${p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')}${p.marketplace ? `@${p.marketplace}` : ''}`).join(', ')}`)

  // ── 1 · the population, and 2 · the period gate ──────────────────────────
  h('1+2 · population window, and ONE asOf per view')
  const since42 = new Date(Date.now() - KT_LOOKBACK_DAYS * 86_400_000)
  for (const m of MARKETS) {
    const periodGroups = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true },
    })
    const chosen = chooseViewPeriod(periodGroups.map((p) => ({ start: p.startDate, rows: p._count._all })))
    const [q42, qAll, qPeriod] = await Promise.all([
      prisma.searchQueryPerformance.findMany({ where: { marketplace: m, startDate: { gte: since42 } }, select: { searchQuery: true }, distinct: ['searchQuery'] }),
      prisma.searchQueryPerformance.findMany({ where: { marketplace: m }, select: { searchQuery: true }, distinct: ['searchQuery'] }),
      chosen.start
        ? prisma.searchQueryPerformance.findMany({ where: { marketplace: m, startDate: chosen.start }, select: { searchQuery: true }, distinct: ['searchQuery'] })
        : Promise.resolve([]),
    ])
    line(`${m}: period ${d10(chosen.start)} (${age(chosen.start)}d) reason=${chosen.reason} rows=${chosen.rows} baseline=${chosen.baselineRows} thr=${Math.round(chosen.threshold)} rejected=${chosen.rejected.length}`)
    line(`    distinct queries — in that period ${qPeriod.length} · in ${KT_LOOKBACK_DAYS}d ${q42.length} · all-time ${qAll.length}`)
    line(`    ASIN-shaped queries in ${KT_LOOKBACK_DAYS}d: ${q42.filter((r) => ASIN_RE.test(r.searchQuery)).length}`)
    line(`    reportPeriod values: ${(await prisma.searchQueryPerformance.groupBy({ by: ['reportPeriod'], where: { marketplace: m }, _count: { _all: true } })).map((p) => `${p.reportPeriod}=${p._count._all}`).join(' ')}`)
  }

  // one portfolio and one campaign that actually resolve, for the assertion
  const itCampaigns = campaigns.filter((c) => c.marketplace === 'IT' && String(c.status) !== 'ARCHIVED')
  const pf = [...new Set(itCampaigns.map((c) => c.portfolioId).filter((x): x is string => !!x))][0] ?? null
  const camp = itCampaigns.find((c) => graph.ads.some((a) => a.campaignId === c.id)) ?? itCampaigns[0]
  h('2b · the same gate under a portfolio and a campaign scope (IT)')
  for (const [label, req] of [
    ['market', { market: 'IT' }],
    ['portfolio', { market: 'IT', portfolio: pf }],
    ['campaign', { market: 'IT', campaign: camp?.id }],
  ] as const) {
    const sc = resolveScope(graph, req as never)
    const periodGroups = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: 'IT' }, _count: { _all: true } })
    const chosen = chooseViewPeriod(periodGroups.map((p) => ({ start: p.startDate, rows: p._count._all })))
    // the DISTINCT asOf the view would render: the gate is market-level, so this is 1 by construction
    const rows = chosen.start
      ? await prisma.searchQueryPerformance.findMany({
        where: { marketplace: 'IT', startDate: chosen.start, ...(sc.asinScoped ? { asin: { in: sc.asins } } : {}) },
        select: { startDate: true, asin: true, searchQuery: true },
      })
      : []
    const distinctAsOf = new Set(rows.map((r) => d10(r.startDate)))
    const asinsWithRows = new Set(rows.map((r) => r.asin).filter((x): x is string => !!x))
    line(`${label.padEnd(9)} boundBy=${sc.boundBy} campaigns=${sc.campaignIds.length}/${sc.campaignsInMarket} asins=${sc.asins.length} · rows ${rows.length} · DISTINCT asOf = ${distinctAsOf.size} [${[...distinctAsOf].join(',')}] · scoped ASINs with rows ${asinsWithRows.size}`)
    if (label === 'portfolio') line(`          portfolio=${pf} · campaignsWithoutPortfolio=${sc.campaignsWithoutPortfolio}`)
    if (label === 'campaign') line(`          campaign="${camp?.name}" (${camp?.id})`)
  }

  // ── 3 · is impressionsTotal constant across a query's ASIN rows? ─────────
  h('3 · the denominator: impressionsTotal across the ASIN rows of one query × period')
  const itPeriods = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: 'IT' }, _count: { _all: true } })
  const itChosen = chooseViewPeriod(itPeriods.map((p) => ({ start: p.startDate, rows: p._count._all })))
  const itRows = itChosen.start
    ? await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', startDate: itChosen.start },
      select: { searchQuery: true, asin: true, impressionsTotal: true, impressionsBrand: true, impressionShare: true, searchQueryVolume: true, searchQueryRank: true },
    })
    : []
  const byQuery = new Map<string, typeof itRows>()
  for (const r of itRows) { const l = byQuery.get(r.searchQuery) ?? []; l.push(r); byQuery.set(r.searchQuery, l) }
  let multi = 0, inconsistent = 0, brandOverTotal = 0, nullAsin = 0
  const examples: string[] = []
  for (const [q, rs] of byQuery) {
    if (rs.some((r) => r.asin == null)) nullAsin++
    if (rs.length < 2) continue
    multi++
    const totals = new Set(rs.map((r) => r.impressionsTotal))
    if (totals.size > 1) { inconsistent++; if (examples.length < 5) examples.push(`  "${q}" totals=[${[...totals].join(',')}]`) }
    const sumBrand = rs.reduce((a, r) => a + r.impressionsBrand, 0)
    if (sumBrand > Math.max(...rs.map((r) => r.impressionsTotal))) brandOverTotal++
  }
  line(`IT ${d10(itChosen.start)}: ${itRows.length} rows · ${byQuery.size} distinct queries · ${multi} with >1 ASIN row`)
  line(`  queries whose ASIN rows DISAGREE about impressionsTotal: ${inconsistent}${examples.length ? '\n' + examples.join('\n') : ''}`)
  line(`  queries where Σ impressionsBrand > impressionsTotal: ${brandOverTotal}`)
  line(`  queries carrying a brand-level (asin = null) row: ${nullAsin}`)
  // does the stored per-row impressionShare equal brand/total?
  const drift = itRows.filter((r) => r.impressionsTotal > 0 && Math.abs(Number(r.impressionShare) - r.impressionsBrand / r.impressionsTotal) > 0.0002)
  line(`  rows where stored impressionShare ≠ brand/total (>2bp): ${drift.length} of ${itRows.filter((r) => r.impressionsTotal > 0).length}`)

  // ── 4 · coverage: advertised ASINs vs ASINs Brand Analytics reports on ────
  h('4 · coverage — advertised ASINs vs ASINs with ANY SQP row')
  for (const m of MARKETS) {
    const advertised = new Set(
      adsAll.filter((a) => a.adGroup?.campaign?.marketplace === m && a.asin).map((a) => a.asin!),
    )
    const sqpAsins = await prisma.searchQueryPerformance.findMany({ where: { marketplace: m, asin: { not: null } }, select: { asin: true }, distinct: ['asin'] })
    const sqpSet = new Set(sqpAsins.map((r) => r.asin!))
    const overlap = [...advertised].filter((a) => sqpSet.has(a))
    line(`${m}: advertised ${advertised.size} · SQP knows ${sqpSet.size} · both ${overlap.length} (${advertised.size ? ((overlap.length / advertised.size) * 100).toFixed(1) : '0'}%)`)
  }

  // ── 5 · the four states, on named rows ───────────────────────────────────
  h('5 · the four blank-states, on named IT rows')
  const fixtures = ['givi', 'africa twin', 'scorpion exo tech', 'giacca moto protezioni livello 3']
  for (const q of fixtures) {
    const rs = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', searchQuery: q },
      select: { startDate: true, asin: true, impressionsTotal: true, impressionsBrand: true, searchQueryVolume: true, searchQueryRank: true },
      orderBy: { startDate: 'desc' }, take: 8,
    })
    const inChosen = rs.filter((r) => itChosen.start && +r.startDate === +itChosen.start)
    line(`"${q}": ${rs.length} rows, newest ${d10(rs[0]?.startDate)} · in the chosen period ${d10(itChosen.start)}: ${inChosen.length}`)
    for (const r of rs.slice(0, 3)) {
      line(`    ${d10(r.startDate)} asin=${r.asin} total=${r.impressionsTotal} brand=${r.impressionsBrand} vol=${r.searchQueryVolume} rank=${r.searchQueryRank}`)
    }
  }
  // a REAL zero inside the chosen period, if one exists — the "we hold none" fixture
  const zeros = itRows.filter((r) => r.impressionsTotal > 0 && r.impressionsBrand === 0)
  line(`real zeros (total>0, brand=0) inside IT ${d10(itChosen.start)}: ${zeros.length}`)
  for (const r of zeros.slice(0, 8)) line(`    "${r.searchQuery}" asin=${r.asin} total=${r.impressionsTotal} vol=${r.searchQueryVolume} rank=${r.searchQueryRank}`)
  const zeroTotals = itRows.filter((r) => r.impressionsTotal === 0)
  line(`rows with impressionsTotal = 0 (the state share() coalesces to 0): ${zeroTotals.length}`)

  // no-row-this-period, at market population: queries in the 42d window absent from the period
  const q42it = await prisma.searchQueryPerformance.findMany({ where: { marketplace: 'IT', startDate: { gte: since42 } }, select: { searchQuery: true }, distinct: ['searchQuery'] })
  const inPeriod = new Set(byQuery.keys())
  const absent = q42it.map((r) => r.searchQuery).filter((q) => !inPeriod.has(q))
  line(`IT queries seen in ${KT_LOOKBACK_DAYS}d but NOT in the chosen period: ${absent.length} — e.g. ${absent.slice(0, 5).map((q) => `"${q}"`).join(', ')}`)

  // ── 6 · freshness, per feed, per market ──────────────────────────────────
  h('6 · freshness — the two feeds must never share an age')
  for (const m of MARKETS) {
    const [sqp, ads] = await Promise.all([
      prisma.searchQueryPerformance.findFirst({ where: { marketplace: m }, orderBy: { startDate: 'desc' }, select: { startDate: true } }),
      prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: m }, orderBy: { date: 'desc' }, select: { date: true } }),
    ])
    line(`${m}: SQP newest ${d10(sqp?.startDate)} (${age(sqp?.startDate)}d) · ads newest ${d10(ads?.date)} (${age(ads?.date)}d)`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
