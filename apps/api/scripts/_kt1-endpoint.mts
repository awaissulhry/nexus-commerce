/**
 * _kt1-endpoint.mts — exercise getKeywordTracker() against prod, exactly as the route will (read-only).
 *
 * Verifies the whole response, not just that it returns: the scope cascade at all four grains, the
 * branded default, the measured filter, sort/paging, and that a real zero share and a never-measured
 * term come back as DIFFERENT facts.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt1-endpoint.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker } from '../src/services/advertising/keyword-tracker.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 66 - s.length))}`) }
const p3 = (n: number | null) => (n == null ? '     —' : `${(n * 100).toFixed(3)}%`)

async function main() {
  h('IT · default view (branded excluded, sort volume desc)')
  const it = await getKeywordTracker({ market: 'IT' })
  line(`scope: boundBy=${it.scope.boundBy} campaigns=${it.scope.resolved.campaigns} asins=${it.scope.resolved.asins}`)
  line(`       watched=${it.scope.resolved.keywordsWatched} measured=${it.scope.resolved.keywordsMeasured}  list="${it.scope.list?.name}" (${it.scope.list?.marketplace}, ${it.scope.list?.terms} terms)`)
  line(`window: lookback=${it.window.lookbackDays}d newest=${it.window.newestAsOf} oldest=${it.window.oldestAsOf}`)
  line(`        periods used: ${it.window.periodsUsed.map((p) => `${p.start}×${p.terms}`).join(' · ')}`)
  line(`freshness: sqp ${it.freshness.sqp.latestPeriodStart} (${it.freshness.sqp.ageDays}d, ingested ${it.freshness.sqp.ingestedAt?.slice(0, 10)}) · searchTerm ${it.freshness.searchTerm.latestDate} (${it.freshness.searchTerm.ageDays}d) · tosIS ${it.freshness.placement.latestDate} (${it.freshness.placement.ageDays}d)`)
  line(`total=${it.total} rows returned=${it.rows.length}`)
  line()
  line('keyword                                 volume  rank    share  asins  asOf        age  measured')
  for (const r of it.rows.slice(0, 12)) {
    line(`${r.keyword.slice(0, 38).padEnd(38)} ${String(r.marketVolume ?? '—').padStart(6)} ${String(r.marketRank ?? '—').padStart(5)} ${p3(r.impressionShare).padStart(8)} ${String(r.asinsCompeting).padStart(6)}  ${(r.asOf ?? '—').padEnd(11)} ${String(r.asOfAgeDays ?? '—').padStart(3)}d  ${r.measured}`)
  }
  const zeros = it.rows.filter((r) => r.measured && r.impressionShare === 0)
  const never = it.rows.filter((r) => !r.measured)
  line()
  line(`🔴 the distinction the grid must render: measured at zero = ${zeros.length} (${zeros.map((z) => z.keyword).join(', ')})`)
  line(`   never measured = ${never.length} (${never.slice(0, 9).map((z) => z.keyword).join(', ')})`)
  line(`   multi-ASIN (our own ASINs competing): ${it.rows.filter((r) => r.asinsCompeting > 1).length}`)
  const worst = it.rows.filter((r) => r.asinsCompeting > 1).sort((a, b) => (b.marketVolume ?? 0) - (a.marketVolume ?? 0))[0]
  if (worst) line(`   worst: "${worst.keyword}" — ${worst.asinsCompeting} of our ASINs, best share ${p3(worst.impressionShare)}, market rank #${worst.marketRank}, volume ${worst.marketVolume}`)

  h('IT · branded=1 — the 10 protected terms rejoin the list')
  const branded = await getKeywordTracker({ market: 'IT', branded: true })
  line(`watched ${it.scope.resolved.keywordsWatched} → ${branded.scope.resolved.keywordsWatched}   measured ${it.scope.resolved.keywordsMeasured} → ${branded.scope.resolved.keywordsMeasured}`)
  for (const r of branded.rows.filter((r) => r.branded)) {
    line(`   ${r.keyword.padEnd(12)} measured=${String(r.measured).padEnd(5)} share=${p3(r.impressionShare)} vol=${r.marketVolume ?? '—'} asOf=${r.asOf ?? '—'}`)
  }

  h('IT · measured=yes / measured=no')
  const yes = await getKeywordTracker({ market: 'IT', measured: 'yes' })
  const no = await getKeywordTracker({ market: 'IT', measured: 'no' })
  line(`measured=yes total=${yes.total} (all measured: ${yes.rows.every((r) => r.measured)})`)
  line(`measured=no  total=${no.total} (none measured: ${no.rows.every((r) => !r.measured)})`)
  line(`yes+no = ${yes.total + no.total}  ·  all = ${it.total}  → ${yes.total + no.total === it.total ? 'consistent' : '🔴 INCONSISTENT'}`)

  h('the scope cascade, each grain, on real ids')
  const lines = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
  const galeLine = lines.find((l) => l.sku === 'GALE-JACKET')
  const airmesh = lines.find((l) => l.sku === 'AIRMESH-JACKET')
  for (const l of [galeLine, airmesh]) {
    if (!l) continue
    const r = await getKeywordTracker({ market: 'IT', line: l.id })
    line(`line ${l.sku.padEnd(16)} boundBy=${r.scope.boundBy} campaigns=${r.scope.resolved.campaigns} asins=${r.scope.resolved.asins} watched=${r.scope.resolved.keywordsWatched} measured=${r.scope.resolved.keywordsMeasured} name="${r.scope.line?.name?.slice(0, 40)}"`)
  }
  const pf = await prisma.amazonAdsPortfolio.findFirst({ where: { name: 'IT_Gale' }, select: { externalPortfolioId: true, name: true } })
  if (pf) {
    const r = await getKeywordTracker({ market: 'IT', portfolio: pf.externalPortfolioId })
    line(`portfolio ${pf.name.padEnd(11)} boundBy=${r.scope.boundBy} campaigns=${r.scope.resolved.campaigns} asins=${r.scope.resolved.asins} measured=${r.scope.resolved.keywordsMeasured}`)
    line(`   🔴 unreachable: ${r.scope.unreachable?.campaignsWithoutPortfolio} of ${r.scope.unreachable?.campaignsInMarket} IT campaigns carry no portfolio — this view cannot see them`)
    const camp = await prisma.campaign.findFirst({ where: { portfolioId: pf.externalPortfolioId }, select: { id: true, name: true } })
    if (camp) {
      const rc = await getKeywordTracker({ market: 'IT', portfolio: pf.externalPortfolioId, campaign: camp.id })
      line(`campaign "${camp.name.slice(0, 30)}" (portfolio ALSO supplied) → boundBy=${rc.scope.boundBy} campaigns=${rc.scope.resolved.campaigns} asins=${rc.scope.resolved.asins} measured=${rc.scope.resolved.keywordsMeasured}`)
      line(`   most-specific-wins holds: ${rc.scope.boundBy === 'campaign' ? 'yes' : '🔴 no'}`)
    }
  }

  h('the other three markets — the page must not pretend')
  for (const m of ['DE', 'ES', 'FR'] as const) {
    const r = await getKeywordTracker({ market: m })
    line(`${m}: watched=${r.scope.resolved.keywordsWatched} measured=${r.scope.resolved.keywordsMeasured} campaigns=${r.scope.resolved.campaigns} asins=${r.scope.resolved.asins} · list="${r.scope.list?.name}" (${r.scope.list?.marketplace}) · sqp ${r.freshness.sqp.latestPeriodStart} (${r.freshness.sqp.ageDays}d)`)
    line(`   periods used: ${r.window.periodsUsed.map((p) => `${p.start}×${p.terms}`).join(' · ') || '(none — nothing measured in the window)'}`)
  }

  h('sort + paging')
  for (const s of ['share', 'rank', 'asins', 'keyword'] as const) {
    const r = await getKeywordTracker({ market: 'IT', sort: s, dir: 'desc', limit: 3 })
    line(`sort=${s.padEnd(8)} → ${r.rows.map((x) => `${x.keyword.slice(0, 22)}(${s === 'share' ? p3(x.impressionShare) : s === 'rank' ? `#${x.marketRank}` : s === 'asins' ? x.asinsCompeting : x.keyword.slice(0, 3)})`).join(' · ')}`)
  }
  const pg1 = await getKeywordTracker({ market: 'IT', limit: 5, offset: 0 })
  const pg2 = await getKeywordTracker({ market: 'IT', limit: 5, offset: 5 })
  line(`limit=5 offset=0 → ${pg1.rows.map((r) => r.keyword.slice(0, 14)).join(' | ')}`)
  line(`limit=5 offset=5 → ${pg2.rows.map((r) => r.keyword.slice(0, 14)).join(' | ')}`)
  line(`no overlap: ${!pg1.rows.some((a) => pg2.rows.some((b) => b.keyword === a.keyword))}  ·  total stays ${pg1.total}/${pg2.total}`)

  h('timing — this grid is a full SQP scan joined to the ad graph')
  const t0 = Date.now(); await getKeywordTracker({ market: 'IT' }); const t1 = Date.now()
  line(`IT default view: ${t1 - t0}ms`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
