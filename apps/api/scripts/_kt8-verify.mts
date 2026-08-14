/**
 * KT.8 — drive the REAL service, per market, and re-run KT.1b's invariant.
 *
 * Calls `getKeywordTracker` exactly as the route does, so this is the page's own answer and not a
 * reconstruction of it.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker, KT_MARKETS, KT_COVERAGE_FLOOR } from '../src/services/advertising/keyword-tracker.service.js'

console.log(`━━━ the gate, per market · floor = ${KT_COVERAGE_FLOOR} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
for (const market of KT_MARKETS) {
  const d: any = await getKeywordTracker({ market } as any)
  const w = d.window
  console.log(`  ${market}: ${w.period ?? 'none'} (${w.periodAgeDays ?? '—'}d) · ${w.asins} ASINs measured (floor ${w.floorAsins}) · ${w.periodRows} rows`)
  console.log(`      reason=${w.reason} truncated=${w.truncated} · bestInWindow=${w.bestAsinsInWindow} · activeListings=${w.activeListings}`)
  console.log(`      rejected newer: ${w.rejected?.map((r: any) => `${r.start.slice(5,10)}:${r.rows}r`).join(' ') || '—'}`)

  // 🔴 KT.1b's invariant: ONE period per view. Every rendered row must carry the same asOf, and no
  // row may come from a different week. An inversion is a row whose period differs from the view's.
  const rows: any[] = d.rows ?? []
  const withShare = rows.filter((r) => r.measured === true && r.impressionShare != null)
  const inversions = withShare.filter((r) => r.asOf && w.period && r.asOf.slice(0, 10) !== w.period.slice(0, 10))
  console.log(`      rows=${rows.length} withShare=${withShare.length} · 🔴 INVERSIONS=${inversions.length}${inversions.length ? ' ' + inversions.slice(0,3).map((r:any)=>`${r.term}@${r.asOf?.slice(0,10)}`).join(' ') : ''}`)

  // KT.3's Δ computability — it will not be what it was on the old periods
  const withDelta = rows.filter((r) => r.deltaPP != null)
  console.log(`      KT.3 Δ share computable on ${withDelta.length} of ${withShare.length} measured rows`)
}

console.log('\n━━━ KT.1b inversion count, the three scopes it used ━━━━━━━━━━━━━━━━━━━━━━')
// 🔴 Campaign.portfolioId is Amazon's EXTERNAL portfolio id, not a local row id (service line 191).
const port = await prisma.amazonAdsPortfolio.findFirst({
  // 🔴 scoped to IT_Gale by name: a bare 'Gale' match returns DE_Gale, which against market IT
  // yields 0 measured rows — an inversion count of 0 over an empty grid proves nothing.
  where: { name: { contains: 'IT_Gale', mode: 'insensitive' } }, select: { externalPortfolioId: true, name: true },
})
const camp = await prisma.campaign.findFirst({ where: { name: { contains: 'Gale Jacket Yellow Only', mode: 'insensitive' } }, select: { id: true, name: true } })
const scopes: Array<[string, any]> = [
  ['IT default', { market: 'IT' }],
  [`portfolio ${port?.name ?? '(none)'}`, port ? { market: 'IT', portfolio: port.externalPortfolioId } : null],
  [`campaign ${camp?.name ?? '(none)'}`, camp ? { market: 'IT', campaign: camp.id } : null],
]
for (const [label, q] of scopes) {
  if (!q) { console.log(`  ${label}: scope not found — reporting rather than skipping silently`); continue }
  const d: any = await getKeywordTracker(q)
  const rows: any[] = d.rows ?? []
  const withShare = rows.filter((r) => r.measured === true && r.impressionShare != null)
  const inv = withShare.filter((r) => r.asOf && d.window.period && r.asOf.slice(0, 10) !== d.window.period.slice(0, 10))
  const periods = [...new Set(withShare.map((r) => r.asOf?.slice(0, 10)))]
  console.log(`  ${label}: period ${d.window.period} · ${withShare.length} measured rows · distinct periods on grid [${periods.join(',')}] · INVERSIONS ${inv.length}`)
}
await prisma.$disconnect()
