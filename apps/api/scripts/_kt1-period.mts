/**
 * _kt1-period.mts — which SQP period should a row read? (read-only)
 *
 * The brief says: "take the latest SQP period that has rows for that market (not MAX(startDate)
 * globally)". Measured on prod, that rule renders the IT watchlist as 2 measured rows and 105
 * "not measured" — because IT's latest stored period (2026-07-26) holds 8 rows in total, while the
 * period before it (2026-07-19) holds all 97 curated terms.
 *
 * This measures the three candidate rules side by side, per market, so the choice is made on
 * numbers and not on preference:
 *   A · market-latest        — one period for the whole grid (the brief, literally)
 *   B · term-latest, bounded — per term, the newest period within a lookback that holds a row
 *   C · term-latest, unbounded — per term, the newest period ever
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt1-period.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 66 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const ageOf = (d: Date | null | undefined) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null)

const MARKETS = ['IT', 'DE', 'ES', 'FR']
const LOOKBACK_DAYS = 56

async function main() {
  const sets = await prisma.keywordCoverageSet.findMany({ select: { id: true, marketplace: true, name: true } })
  const terms = await prisma.keywordCoverageTerm.findMany({ where: { setId: { in: sets.map((s) => s.id) } }, select: { term: true } })
  const prot = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' }, select: { term: true } })
  const coverage = [...new Set(terms.map((t) => t.term.toLowerCase().trim()))]
  const protected_ = [...new Set(prot.map((p) => p.term.toLowerCase().trim()))]
  const watch = [...new Set([...coverage, ...protected_])]
  line(`watchlist: ${coverage.length} coverage + ${protected_.length} protected = ${watch.length} distinct terms`)
  line(`(the coverage set is IT-only; the same watchlist is evaluated against every market below)`)

  const since = new Date(); since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS); since.setUTCHours(0, 0, 0, 0)

  for (const mkt of MARKETS) {
    h(`${mkt}`)
    const periods = await prisma.searchQueryPerformance.groupBy({
      by: ['startDate'], where: { marketplace: mkt }, _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 10,
    })
    if (!periods.length) { line('no SQP rows at all'); continue }
    const marketLatest = periods[0].startDate
    line(`periods (newest first): ${periods.map((p) => `${d10(p.startDate)}=${p._count._all}`).join(' · ')}`)
    line(`market-latest = ${d10(marketLatest)} (${ageOf(marketLatest)}d), holding ${periods[0]._count._all} rows in total`)

    // every watchlist row within the lookback, so all three rules read the same source data
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: mkt, searchQuery: { in: watch }, startDate: { gte: since } },
      select: { searchQuery: true, asin: true, startDate: true, impressionShare: true, searchQueryVolume: true, searchQueryRank: true },
    })
    const everRows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: mkt, searchQuery: { in: watch } },
      select: { searchQuery: true, startDate: true },
    })

    // A — market-latest
    const aTerms = new Set(rows.filter((r) => +r.startDate === +marketLatest).map((r) => r.searchQuery.toLowerCase()))
    // B — term-latest within the lookback
    const bLatest = new Map<string, Date>()
    for (const r of rows) {
      const k = r.searchQuery.toLowerCase()
      const cur = bLatest.get(k)
      if (!cur || +r.startDate > +cur) bLatest.set(k, r.startDate)
    }
    // C — term-latest ever
    const cLatest = new Map<string, Date>()
    for (const r of everRows) {
      const k = r.searchQuery.toLowerCase()
      const cur = cLatest.get(k)
      if (!cur || +r.startDate > +cur) cLatest.set(k, r.startDate)
    }

    line()
    line(`A · market-latest       measured ${String(aTerms.size).padStart(3)} of ${watch.length}   not measured ${watch.length - aTerms.size}`)
    line(`B · term-latest ≤${LOOKBACK_DAYS}d    measured ${String(bLatest.size).padStart(3)} of ${watch.length}   not measured ${watch.length - bLatest.size}`)
    line(`C · term-latest ever    measured ${String(cLatest.size).padStart(3)} of ${watch.length}   not measured ${watch.length - cLatest.size}`)

    if (bLatest.size) {
      const spread = new Map<string, number>()
      for (const d of bLatest.values()) spread.set(d10(d), (spread.get(d10(d)) ?? 0) + 1)
      line(`B period spread: ${[...spread.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([d, n]) => `${d}×${n}`).join(' · ')}`)
      const ages = [...bLatest.values()].map((d) => ageOf(d)!).sort((a, b) => a - b)
      line(`B row age: min ${ages[0]}d · median ${ages[Math.floor(ages.length / 2)]}d · max ${ages[ages.length - 1]}d`)
    }
    if (cLatest.size > bLatest.size) {
      const beyond = [...cLatest.entries()].filter(([k]) => !bLatest.has(k))
      line(`C adds ${beyond.length} terms whose newest row is older than ${LOOKBACK_DAYS}d: ${beyond.slice(0, 5).map(([k, d]) => `${k}@${d10(d)}`).join(' · ')}${beyond.length > 5 ? ' …' : ''}`)
    }

    // what a B row looks like, and the real-zero vs never-measured split
    if (bLatest.size) {
      const assembled = [...bLatest.entries()].map(([term, period]) => {
        const rs = rows.filter((r) => r.searchQuery.toLowerCase() === term && +r.startDate === +period)
        const best = rs.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))
        return { term, period, share: Number(best.impressionShare), volume: best.searchQueryVolume, rank: best.searchQueryRank, asins: new Set(rs.map((r) => r.asin)).size }
      })
      line(`B rows: real zero share ${assembled.filter((r) => r.share === 0).length} · >0% ${assembled.filter((r) => r.share > 0).length} · >1% ${assembled.filter((r) => r.share > 0.01).length} · multi-ASIN ${assembled.filter((r) => r.asins > 1).length}`)
      const top = assembled.sort((a, b) => b.volume - a.volume).slice(0, 6)
      for (const r of top) line(`   ${r.term.slice(0, 34).padEnd(34)} vol=${String(r.volume).padStart(6)} rank=${String(r.rank ?? '—').padStart(4)} share=${(r.share * 100).toFixed(3)}% asins=${r.asins} asOf=${d10(r.period)}`)
    }
  }

  h('scope cascade: does a narrower scope still leave rows on the grid? (IT, rule B)')
  const ads = await prisma.adProductAd.findMany({
    where: { productId: { not: null }, asin: { not: null } },
    select: { productId: true, asin: true, adGroup: { select: { campaignId: true, campaign: { select: { marketplace: true, portfolioId: true, name: true } } } } },
  })
  const products = await prisma.product.findMany({ where: { id: { in: [...new Set(ads.map((a) => a.productId!))] } }, select: { id: true, parentId: true, sku: true } })
  const parentOf = new Map(products.map((p) => [p.id, p.parentId ?? p.id]))
  const skuOfLine = new Map(products.filter((p) => !p.parentId).map((p) => [p.id, p.sku]))
  const parentSkus = await prisma.product.findMany({ where: { id: { in: [...new Set([...parentOf.values()])] } }, select: { id: true, sku: true } })
  for (const p of parentSkus) skuOfLine.set(p.id, p.sku)

  const itRows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'IT', searchQuery: { in: watch }, startDate: { gte: since } },
    select: { searchQuery: true, asin: true, startDate: true },
  })
  const measuredFor = (asins: Set<string>) => {
    const t = new Set<string>()
    for (const r of itRows) if (r.asin && asins.has(r.asin)) t.add(r.searchQuery.toLowerCase())
    return t.size
  }
  const allItAsins = new Set(ads.filter((a) => a.adGroup?.campaign?.marketplace === 'IT').map((a) => a.asin!))
  line(`IT, no line/portfolio/campaign scope: asins=${allItAsins.size} → watchlist terms measured=${measuredFor(allItAsins)}`)

  const byLine = new Map<string, Set<string>>()
  for (const a of ads) {
    if (a.adGroup?.campaign?.marketplace !== 'IT') continue
    const lk = parentOf.get(a.productId!) ?? a.productId!
    const s = byLine.get(lk) ?? new Set<string>(); s.add(a.asin!); byLine.set(lk, s)
  }
  for (const [lk, asins] of [...byLine.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8)) {
    line(`  line ${String(skuOfLine.get(lk) ?? lk).slice(0, 22).padEnd(22)} asins=${String(asins.size).padStart(3)} → measured=${measuredFor(asins)}`)
  }

  const byPf = new Map<string, Set<string>>()
  for (const a of ads) {
    const pf = a.adGroup?.campaign?.portfolioId
    if (!pf || a.adGroup?.campaign?.marketplace !== 'IT') continue
    const s = byPf.get(pf) ?? new Set<string>(); s.add(a.asin!); byPf.set(pf, s)
  }
  const pfNames = new Map((await prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } })).map((p) => [p.externalPortfolioId, p.name]))
  for (const [pf, asins] of [...byPf.entries()].sort((a, b) => b[1].size - a[1].size)) {
    line(`  portfolio ${String(pfNames.get(pf) ?? pf).slice(0, 20).padEnd(20)} asins=${String(asins.size).padStart(3)} → measured=${measuredFor(asins)}`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
