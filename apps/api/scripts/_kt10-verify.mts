/** KT.10 — drive the REAL service and check what the page will now be able to say. */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker, KT_MARKETS, SQP_QUERIES_PER_ASIN_CAP } from '../src/services/advertising/keyword-tracker.service.js'

console.log(`cap = ${SQP_QUERIES_PER_ASIN_CAP}\n`)
for (const market of KT_MARKETS) {
  const d: any = await getKeywordTracker({ market } as any)
  const w = d.window, m = w.market
  console.log(`━━━ ${market} · period ${w.period} (${w.periodAgeDays}d) · ${w.asins} ASINs · floor ${w.floorAsins} · ${w.reason}${w.truncated ? ' TRUNCATED' : ''}`)
  if (!m) console.log(`   market movement: null  (fewer than 5 overlapping pairs — reported as absent, not as 0%)`)
  else console.log(`   vs ${m.priorPeriod} on ${m.pairs} pairs · volume ${m.volumeDeltaPct?.toFixed(0)}% · ourImpr ${m.ourImpressionsDeltaPct?.toFixed(0)}% · share ${m.sharePriorPct?.toFixed(3)}% → ${m.shareNowPct?.toFixed(3)}% · settled=${m.newestIsSettled}`)
  const rows: any[] = d.rows ?? []
  const measured = rows.filter((r) => r.measured === true && r.impressionShare != null)
  const withMkt = measured.filter((r) => r.marketDeltaPct != null)
  console.log(`   rows ${rows.length} · measured ${measured.length} · with a market Δ ${withMkt.length}`)
  const inv = measured.filter((r) => r.asOf && w.period && r.asOf.slice(0, 10) !== w.period.slice(0, 10))
  console.log(`   🔴 INVERSIONS ${inv.length}`)
  const ex = withMkt.slice(0, 3).map((r) => `${r.keyword}: ${r.deltaPP > 0 ? '+' : ''}${r.deltaPP.toFixed(2)}pp · mkt ${r.marketDeltaPct > 0 ? '+' : ''}${r.marketDeltaPct.toFixed(0)}%`)
  if (ex.length) console.log(`   e.g. ${ex.join('  |  ')}`)
}
console.log('\n━━━ KT.1b inversion count, the three scopes ━━━')
const port = await prisma.amazonAdsPortfolio.findFirst({ where: { name: { contains: 'IT_Gale', mode: 'insensitive' } }, select: { externalPortfolioId: true, name: true } })
const camp = await prisma.campaign.findFirst({ where: { name: { contains: 'Gale Jacket Yellow Only', mode: 'insensitive' } }, select: { id: true, name: true } })
for (const [label, q] of [['IT default', { market: 'IT' }], [`portfolio ${port?.name}`, port ? { market: 'IT', portfolio: port.externalPortfolioId } : null], [`campaign ${camp?.name}`, camp ? { market: 'IT', campaign: camp.id } : null]] as Array<[string, any]>) {
  if (!q) { console.log(`  ${label}: scope not found`); continue }
  const d: any = await getKeywordTracker(q)
  const rows: any[] = d.rows ?? []
  const measured = rows.filter((r) => r.measured === true && r.impressionShare != null)
  const periods = [...new Set(measured.map((r) => r.asOf?.slice(0, 10)))]
  const inv = measured.filter((r) => r.asOf && d.window.period && r.asOf.slice(0, 10) !== d.window.period.slice(0, 10))
  console.log(`  ${label}: period ${d.window.period} · ${measured.length} measured · periods [${periods.join(',')}] · INVERSIONS ${inv.length}`)
}
await prisma.$disconnect()
