/**
 * _sov0-zero.mts — find a REAL "we hold none" row that a shipped view can actually render.
 *
 * `_sov0-states.mts` measured 0 real zeros at QUERY grain in all four markets' chosen periods, so
 * the brief's four IT fixtures (which are 2026-07-12 rows, read per ASIN) cannot demonstrate the
 * state on the default grid. But a zero at query grain is the SUM over our covered ASINs — and a
 * per-ASIN row of 0 is common. So a scope that resolves to that one ASIN renders a genuine
 * `impressionsBrand = 0` against a real market total.
 *
 * This finds one, and names the exact URL that renders it.
 *
 * NO WRITES.
 * Run from apps/api: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_sov0-zero.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { resolveScope, chooseViewPeriod, type KtScopeGraph } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

async function chosenFor(market: string) {
  const g = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], where: { marketplace: market }, _count: { _all: true } })
  return chooseViewPeriod(g.map((p) => ({ start: p.startDate, rows: p._count._all })))
}

async function main() {
  h('1 · per-ASIN zero rows inside each market\'s chosen period')
  const zeroAsins: Record<string, Array<{ q: string; asin: string; total: number; vol: number }>> = {}
  for (const m of MARKETS) {
    const chosen = await chosenFor(m)
    if (!chosen.start) continue
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: m, startDate: chosen.start, impressionsBrand: 0, impressionsTotal: { gt: 0 } },
      select: { searchQuery: true, asin: true, impressionsTotal: true, searchQueryVolume: true },
      orderBy: { impressionsTotal: 'desc' }, take: 2000,
    })
    zeroAsins[m] = rows.map((r) => ({ q: r.searchQuery, asin: r.asin ?? '', total: r.impressionsTotal, vol: r.searchQueryVolume }))
    line(`${m} ${d10(chosen.start)}: ${rows.length} per-ASIN rows with brand=0 and a real market total`)
    for (const r of rows.slice(0, 5)) line(`    "${r.searchQuery}" asin=${r.asin} total=${r.impressionsTotal} vol=${r.searchQueryVolume}`)
  }

  h('2 · a scope that renders one — campaign / portfolio whose ASINs are exactly the zero ones')
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

  for (const m of MARKETS) {
    const zs = zeroAsins[m] ?? []
    if (!zs.length) continue
    const chosen = await chosenFor(m)
    const inMarket = campaigns.filter((c) => c.marketplace === m && String(c.status) !== 'ARCHIVED')
    let found = 0
    for (const c of inMarket) {
      const sc = resolveScope(graph, { market: m, campaign: c.id })
      if (!sc.asins.length) continue
      // the queries this campaign's ASINs are measured on, aggregated the way the service will
      const rows = chosen.start
        ? await prisma.searchQueryPerformance.findMany({
          where: { marketplace: m, startDate: chosen.start, asin: { in: sc.asins } },
          select: { searchQuery: true, asin: true, impressionsTotal: true, impressionsBrand: true, searchQueryVolume: true, searchQueryRank: true },
        })
        : []
      const agg = new Map<string, { total: number; brand: number; vol: number; rank: number | null; n: number }>()
      for (const r of rows) {
        const a = agg.get(r.searchQuery) ?? { total: 0, brand: 0, vol: 0, rank: null, n: 0 }
        a.total = Math.max(a.total, r.impressionsTotal); a.brand += r.impressionsBrand
        a.vol = Math.max(a.vol, r.searchQueryVolume); a.rank = a.rank == null ? r.searchQueryRank : Math.min(a.rank, r.searchQueryRank ?? 1e9)
        a.n++; agg.set(r.searchQuery, a)
      }
      const zeros = [...agg.entries()].filter(([, a]) => a.total > 0 && a.brand === 0).sort((x, y) => y[1].total - x[1].total)
      if (!zeros.length) continue
      line(`${m} campaign "${c.name}" (${c.id}) — ${sc.asins.length} ASINs, ${agg.size} measured queries, ${zeros.length} REAL ZEROS`)
      for (const [q, a] of zeros.slice(0, 4)) line(`      ZERO "${q}" marketTotal=${a.total} vol=${a.vol} rank=${a.rank} ourAsinRows=${a.n}`)
      line(`      URL: /marketing/ads/rules-automation/share-of-voice?market=${m}&campaign=${c.id}`)
      if (++found >= 2) break
    }
    if (!found) line(`${m}: no campaign scope isolates a zero`)
  }

  h('3 · and at PORTFOLIO grain')
  for (const m of MARKETS) {
    if (!(zeroAsins[m] ?? []).length) continue
    const chosen = await chosenFor(m)
    const inMarket = campaigns.filter((c) => c.marketplace === m && String(c.status) !== 'ARCHIVED')
    const pfs = [...new Set(inMarket.map((c) => c.portfolioId).filter((x): x is string => !!x))]
    for (const pf of pfs) {
      const sc = resolveScope(graph, { market: m, portfolio: pf })
      if (!sc.asins.length) continue
      const rows = chosen.start
        ? await prisma.searchQueryPerformance.findMany({
          where: { marketplace: m, startDate: chosen.start, asin: { in: sc.asins } },
          select: { searchQuery: true, impressionsTotal: true, impressionsBrand: true, searchQueryVolume: true },
        })
        : []
      const agg = new Map<string, { total: number; brand: number; vol: number }>()
      for (const r of rows) {
        const a = agg.get(r.searchQuery) ?? { total: 0, brand: 0, vol: 0 }
        a.total = Math.max(a.total, r.impressionsTotal); a.brand += r.impressionsBrand; a.vol = Math.max(a.vol, r.searchQueryVolume)
        agg.set(r.searchQuery, a)
      }
      const zeros = [...agg.entries()].filter(([, a]) => a.total > 0 && a.brand === 0).sort((x, y) => y[1].total - x[1].total)
      if (!zeros.length) continue
      line(`${m} portfolio ${pf}: ${sc.campaignIds.length} campaigns, ${sc.asins.length} ASINs, ${agg.size} measured, ${zeros.length} REAL ZEROS`)
      for (const [q, a] of zeros.slice(0, 4)) line(`      ZERO "${q}" marketTotal=${a.total} vol=${a.vol}`)
      line(`      URL: /marketing/ads/rules-automation/share-of-voice?market=${m}&portfolio=${pf}`)
      break
    }
  }

  // ── 4 · is the state real in the FEED at all? zero rows by period ────────
  // Appended after 1-3 returned 0 everywhere: the state exists in the data but not in any period
  // the gate renders, so the doc states the gap rather than claiming a demonstration it cannot make.
  h('4 · zero rows BY PERIOD — the state is real in the feed, just not in the rendered week')
  for (const m of MARKETS) {
    const groups = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 12,
    })
    const chosen = await chosenFor(m)
    const bits: string[] = []
    for (const g of groups) {
      const z = await prisma.searchQueryPerformance.count({
        where: { marketplace: m, startDate: g.startDate, impressionsBrand: 0, impressionsTotal: { gt: 0 } },
      })
      bits.push(`${d10(g.startDate)}${chosen.start && +g.startDate === +chosen.start ? '<CHOSEN' : ''}:${z}/${g._count._all}`)
    }
    line(`${m}: ${bits.join('  ')}`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
