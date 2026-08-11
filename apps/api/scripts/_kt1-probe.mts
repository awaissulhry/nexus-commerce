/**
 * _kt1-probe.mts — KT.1 pre-build verification (read-only).
 *
 * The build brief lists four stop conditions. Two are answered by reading web files
 * (AdsPageHeader's props; no existing /advertising/keyword-tracker route). The other two, plus
 * every number the page will state on screen, are measured here:
 *
 *   1. KeywordCoverageSet still holds 97 IT terms; AdKeywordProtection still holds 10 whitelist terms.
 *   2. Product.parentId still resolves the advertised children into product lines.
 *   3. The scope spine, end to end: market → line → portfolio → campaign → ASINs → SQP rows.
 *   4. Freshness per source, per market, exactly as the endpoint will report it.
 *   5. The day-one grid for the default view (IT, branded excluded) — the rows the page must render.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt1-probe.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 66 - s.length))}`) }
const d10 = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : 'null')
const pct = (n: number) => `${(n * 100).toFixed(3)}%`

const MARKETS = ['IT', 'DE', 'ES', 'FR']

async function main() {
  h('1 · stop condition: the watchlist sources')
  const sets = await prisma.keywordCoverageSet.findMany({
    select: { id: true, name: true, marketplace: true, portfolioId: true, enabled: true, _count: { select: { terms: true } } },
  })
  for (const s of sets) {
    line(`set ${s.id}  "${s.name}"  mkt=${s.marketplace}  portfolio=${s.portfolioId}  enabled=${s.enabled}  terms=${s._count.terms}`)
  }
  const termStatus = await prisma.keywordCoverageTerm.groupBy({ by: ['status', 'isControl'], _count: { _all: true } })
  line(`term status: ${termStatus.map((t) => `${t.status}${t.isControl ? '/control' : ''}=${t._count._all}`).join(' · ')}`)

  const prot = await prisma.adKeywordProtection.findMany({
    select: { term: true, mode: true, matchType: true, isPrefix: true, marketplace: true, campaignId: true },
    orderBy: { term: 'asc' },
  })
  line(`AdKeywordProtection rows: ${prot.length}`)
  for (const p of prot) line(`  ${p.mode} "${p.term}" matchType=${p.matchType ?? `(null, isPrefix=${p.isPrefix})`} mkt=${p.marketplace ?? 'ALL'} campaign=${p.campaignId ?? 'ALL'}`)

  h('2 · stop condition: Product.parentId → product lines over advertised ASINs')
  const ads = await prisma.adProductAd.findMany({
    where: { productId: { not: null } },
    select: { productId: true, asin: true, adGroup: { select: { campaignId: true } } },
  })
  const advertisedIds = [...new Set(ads.map((a) => a.productId!).filter(Boolean))]
  const advertised = await prisma.product.findMany({
    where: { id: { in: advertisedIds } },
    select: { id: true, sku: true, parentId: true },
  })
  const parentIds = [...new Set(advertised.map((p) => p.parentId).filter((x): x is string => !!x))]
  line(`AdProductAd rows with a productId: ${ads.length}`)
  line(`distinct advertised Product rows: ${advertised.length}`)
  line(`  with a parentId: ${advertised.filter((p) => p.parentId).length}   standalone: ${advertised.filter((p) => !p.parentId).length}`)
  line(`distinct parents: ${parentIds.length}   ⇒ product lines = ${new Set(advertised.map((p) => p.parentId ?? p.id)).size}`)

  h('3 · the scope spine')
  const campaigns = await prisma.campaign.findMany({
    select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true },
  })
  line(`campaigns: ${campaigns.length}`)
  for (const m of [...MARKETS, null]) {
    const inM = campaigns.filter((c) => (m ? c.marketplace === m : !c.marketplace))
    line(`  ${m ?? '(no marketplace)'}: ${inM.length}  withPortfolio=${inM.filter((c) => c.portfolioId).length}  withoutPortfolio=${inM.filter((c) => !c.portfolioId).length}`)
  }
  const withoutPf = campaigns.filter((c) => !c.portfolioId).length
  line(`ACCOUNT-WIDE: ${campaigns.length - withoutPf} of ${campaigns.length} carry a portfolioId; portfolio scope is blind to ${withoutPf}`)

  const portfolios = await prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } })
  line(`portfolios: ${portfolios.length}`)
  const pfCampaignCount = new Map<string, number>()
  for (const c of campaigns) if (c.portfolioId) pfCampaignCount.set(c.portfolioId, (pfCampaignCount.get(c.portfolioId) ?? 0) + 1)
  for (const p of portfolios.slice(0, 12)) line(`  ${p.externalPortfolioId} "${p.name}" campaigns=${pfCampaignCount.get(p.externalPortfolioId) ?? 0}`)

  // line → children → ASINs, and line → campaigns
  const asinsByProduct = new Map<string, Set<string>>()
  const campaignsByProduct = new Map<string, Set<string>>()
  for (const a of ads) {
    if (!a.productId) continue
    if (a.asin) { const s = asinsByProduct.get(a.productId) ?? new Set(); s.add(a.asin); asinsByProduct.set(a.productId, s) }
    const cid = a.adGroup?.campaignId
    if (cid) { const s = campaignsByProduct.get(a.productId) ?? new Set(); s.add(cid); campaignsByProduct.set(a.productId, s) }
  }
  const lineKey = (p: { id: string; parentId: string | null }) => p.parentId ?? p.id
  const linesMap = new Map<string, { asins: Set<string>; campaigns: Set<string>; children: number }>()
  for (const p of advertised) {
    const k = lineKey(p)
    const e = linesMap.get(k) ?? { asins: new Set<string>(), campaigns: new Set<string>(), children: 0 }
    e.children += 1
    for (const a of asinsByProduct.get(p.id) ?? []) e.asins.add(a)
    for (const c of campaignsByProduct.get(p.id) ?? []) e.campaigns.add(c)
    linesMap.set(k, e)
  }
  const parentNames = await prisma.product.findMany({ where: { id: { in: [...linesMap.keys()] } }, select: { id: true, sku: true, name: true } })
  const nameById = new Map(parentNames.map((p) => [p.id, `${p.sku} — ${p.name}`]))
  line(`product lines over advertised products: ${linesMap.size}`)
  for (const [id, e] of [...linesMap.entries()].sort((a, b) => b[1].asins.size - a[1].asins.size).slice(0, 14)) {
    line(`  ${id}  ${String(nameById.get(id) ?? '?').slice(0, 46).padEnd(46)} children=${String(e.children).padStart(3)} asins=${String(e.asins.size).padStart(3)} campaigns=${e.campaigns.size}`)
  }

  h('4 · freshness per source per market (what the endpoint will report)')
  for (const m of MARKETS) {
    const sqp = await prisma.searchQueryPerformance.findFirst({
      where: { marketplace: m }, orderBy: { startDate: 'desc' }, select: { startDate: true, ingestedAt: true },
    })
    const st = await prisma.amazonAdsSearchTerm.findFirst({ where: { marketplace: m }, orderBy: { date: 'desc' }, select: { date: true } })
    const pl = await prisma.amazonAdsPlacementReport.findFirst({
      where: { marketplace: m, topOfSearchIS: { not: null } }, orderBy: { date: 'desc' }, select: { date: true },
    })
    const age = (d: Date | null | undefined) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null)
    line(`${m}: sqp start=${d10(sqp?.startDate ?? null)} (${age(sqp?.startDate)}d) ingested=${d10(sqp?.ingestedAt ?? null)} · searchTerm=${d10(st?.date ?? null)} (${age(st?.date)}d) · tosIS=${d10(pl?.date ?? null)} (${age(pl?.date)}d)`)
  }

  h('5 · the day-one grid: 97 coverage terms + 10 protected, IT, latest week WITH ROWS')
  const setIT = sets.find((s) => s.marketplace === 'IT')
  if (!setIT) { line('no IT coverage set — cannot assemble'); return }
  const terms = await prisma.keywordCoverageTerm.findMany({ where: { setId: setIT.id }, select: { term: true, status: true, isControl: true } })
  const protTerms = prot.filter((p) => p.mode === 'WHITELIST').map((p) => p.term.toLowerCase())
  const watch = [...new Set(terms.map((t) => t.term.toLowerCase().trim()))]
  const branded = watch.filter((t) => protTerms.some((p) => t.includes(p)))
  line(`coverage terms: ${terms.length} (${watch.length} distinct, lowercased)`)
  line(`of those, containing a protected term (excluded when branded=0): ${branded.length}${branded.length ? ` → ${branded.join(', ')}` : ''}`)
  line(`protected terms themselves, added to the watchlist: ${protTerms.length}`)

  // "the latest SQP period that HAS ROWS for that market", not MAX(startDate) globally
  const latestIT = await prisma.searchQueryPerformance.findFirst({
    where: { marketplace: 'IT' }, orderBy: { startDate: 'desc' }, select: { startDate: true },
  })
  line(`latest IT period with rows: ${d10(latestIT?.startDate ?? null)}`)
  const all = [...new Set([...watch, ...protTerms])]
  const rows = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'IT', startDate: latestIT!.startDate, searchQuery: { in: all } },
    select: { searchQuery: true, asin: true, searchQueryVolume: true, searchQueryRank: true, impressionShare: true, startDate: true },
  })
  line(`SQP rows in that period for the ${all.length} watched terms: ${rows.length}`)
  const byTerm = new Map<string, typeof rows>()
  for (const r of rows) { const k = r.searchQuery.toLowerCase(); const a = byTerm.get(k) ?? []; a.push(r); byTerm.set(k, a) }
  line(`terms measured in that period: ${byTerm.size} of ${all.length}   NOT measured: ${all.length - byTerm.size}`)
  line()
  line('term                                    volume   rank     share   ourASINs')
  const assembled = [...byTerm.entries()].map(([term, rs]) => {
    const best = rs.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))
    return { term, volume: best.searchQueryVolume, rank: best.searchQueryRank, share: Number(best.impressionShare), asins: new Set(rs.map((r) => r.asin)).size }
  }).sort((a, b) => b.volume - a.volume)
  for (const r of assembled.slice(0, 20)) {
    line(`${r.term.slice(0, 38).padEnd(38)} ${String(r.volume).padStart(7)} ${String(r.rank ?? '—').padStart(6)} ${pct(r.share).padStart(9)} ${String(r.asins).padStart(6)}`)
  }
  line()
  line(`measured at a real zero share: ${assembled.filter((r) => r.share === 0).length}  ·  above 0%: ${assembled.filter((r) => r.share > 0).length}  ·  above 1%: ${assembled.filter((r) => r.share > 0.01).length}`)
  line(`multi-ASIN terms (our own ASINs competing): ${assembled.filter((r) => r.asins > 1).length}`)

  h('6 · does any earlier period hold more of the watchlist? (why "latest with rows" is per-market)')
  const periods = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace: 'IT' }, _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 6,
  })
  for (const p of periods) {
    const n = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', startDate: p.startDate, searchQuery: { in: all } }, select: { searchQuery: true },
    })
    line(`  ${d10(p.startDate)}  rows=${String(p._count._all).padStart(5)}  watchlist terms present=${new Set(n.map((x) => x.searchQuery.toLowerCase())).size}`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
