/** ACR.2.2 — run the real coverage scoreboard against prod. READ-ONLY. */
import '../src/env.js'
const { getCoverageScoreboard, coverageMarketplaces } = await import('../src/services/advertising/ads-coverage.service.js')
const markets = await coverageMarketplaces()
console.log(`\nMarketplaces with SQP data: ${markets.join(', ')}`)
for (const mkt of ['IT', 'DE']) {
  const b = await getCoverageScoreboard({ marketplace: mkt, limit: 12 })
  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)
  const num = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-IE'))
  console.log(`\n${'═'.repeat(100)}\n${mkt} · week ${b.week} · ${b.measured ? 'MEASURED' : 'UNMEASURED'}`)
  console.log(`weeks: ${b.weeks.map((w) => `${w.startDate}${w.measured ? '' : '*'}`).join(' ')}   (* = never re-read)`)
  console.log(`POOLED: ${b.totals.terms} terms · market ${num(b.totals.marketImpressions)} impr · ours ${num(b.totals.ourImpressions)} · share ${pct(b.totals.share)} · buys ${b.totals.marketPurchases} market / ${num(b.totals.ourPurchases)} ours`)
  for (const n of b.notes) console.log(`  NOTE: ${n}`)
  console.log(`\n  ${'term'.padEnd(34)}${'market'.padStart(10)}${'ours'.padStart(8)}${'share'.padStart(8)}${'asins'.padStart(7)}${'kws'.padStart(6)}`)
  for (const r of b.rows) {
    console.log(`  ${r.term.slice(0, 33).padEnd(34)}${num(r.marketImpressions).padStart(10)}${num(r.ourImpressions).padStart(8)}${pct(r.share).padStart(8)}${String(r.ourAsins).padStart(7)}${String(r.targets).padStart(6)}`)
  }
  console.log(`\n  HEADROOM (${b.headroom.length}):`)
  for (const r of b.headroom.slice(0, 8)) {
    console.log(`    ${r.term.slice(0, 33).padEnd(34)}${num(r.marketImpressions).padStart(10)}${pct(r.share).padStart(8)}${String(r.targets).padStart(6)} kw`)
  }
}
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
