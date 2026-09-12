/** READ-ONLY (dryRun) — does the rewritten gap finder see the 130 days, and only those? */
import '../src/env.js'
const { findPerformanceGaps, unattributedSpendOf, REPORT_RETENTION_DAYS } =
  await import('../src/services/advertising/ads-report-gapfill.service.js')

console.log(`retention bound: ${REPORT_RETENTION_DAYS} days`)
for (const look of [14, 120]) {
  const gaps = await findPerformanceGaps(look)
  const day = gaps.filter(g => g.kind === 'day')
  const prod = gaps.filter(g => g.kind === 'advertised-product')
  console.log(`\nlookback ${look}d → ${gaps.length} gaps  ·  whole-day ${day.length}  ·  product-only ${prod.length}  ·  €${unattributedSpendOf(gaps)} unattributed`)
  const byMkt = new Map<string, { n: number; eur: number; first: string; last: string }>()
  for (const g of prod) {
    const e = byMkt.get(g.marketplace) ?? { n: 0, eur: 0, first: g.date, last: g.date }
    e.n++; e.eur += g.unattributedSpend
    if (g.date < e.first) e.first = g.date
    if (g.date > e.last) e.last = g.date
    byMkt.set(g.marketplace, e)
  }
  for (const [m, e] of [...byMkt].sort((a, b) => b[1].eur - a[1].eur)) {
    console.log(`    ${m}  ${String(e.n).padStart(3)} days  €${e.eur.toFixed(2).padStart(9)}  ${e.first} → ${e.last}`)
  }
  if (day.length) console.log(`    whole-day gaps: ${day.slice(0, 6).map(g => `${g.marketplace} ${g.date}`).join(', ')}${day.length > 6 ? ` … +${day.length - 6}` : ''}`)
}
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()
