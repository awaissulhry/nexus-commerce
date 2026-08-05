/**
 * ACR Stage 5 — verify the coverage scoreboard's ad-type attribution on prod. READ-ONLY.
 *
 * The stacking baseline: if this prints one active ad product, no stacking is happening and
 * the Stage 5 hypothesis is untested. It should print SP at 100% today.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr5-adtype-mix.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { getCoverageScoreboard, coverageMarketplaces } = await import('../src/services/advertising/ads-coverage.service.js')

const markets = await coverageMarketplaces()
console.log(`marketplaces with coverage data: ${markets.join(', ') || '(none)'}`)

for (const m of markets) {
  const b = await getCoverageScoreboard({ marketplace: m })
  console.log(`\n════ ${m} — week ${b.week ?? '(none)'} · pooled share ${b.totals.share == null ? '—' : (b.totals.share * 100).toFixed(2) + '%'} ════`)
  console.log(`  active ad products: ${b.adTypeMix.activeAdProducts}  (window ${b.adTypeMix.windowDays}d)`)
  console.log('  AD PRODUCT           IMPRESSIONS      CLICKS      SPEND   SHARE   SEARCH-ATTRIB  STATE')
  for (const a of b.adTypeMix.byAdProduct) {
    console.log(
      '  ' + a.adProduct.padEnd(21) +
      String(a.impressions).padStart(11) +
      String(a.clicks).padStart(12) +
      ('€' + a.costEur.toFixed(2)).padStart(11) +
      ((a.shareOfOurImpressions * 100).toFixed(1) + '%').padStart(8) +
      (a.searchAttributable ? '  yes' : '  no ').padStart(15) +
      (a.dormant ? '   DORMANT' : '   active'),
    )
  }
  for (const n of b.notes.filter((x) => x.includes('ad product'))) console.log(`  → ${n}`)
}
process.exit(0)
