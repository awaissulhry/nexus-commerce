/**
 * ACR.0.2f — run the REAL parser against the REAL captured payload. READ-ONLY.
 *
 * The proof the unit tests could never give: parseSqp against bytes Amazon actually sent
 * (captured to /tmp/acr02-sqp.json by _acr02-sqp-shape.mts), not against a fixture written
 * from the parser's own assumptions.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr02-verify-parser.mts
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { parseSqp, share } = await import('../src/services/advertising/sqp.service.js')

const captured = JSON.parse(readFileSync('/tmp/acr02-sqp.json', 'utf8'))
const payload = captured.payload ?? captured
const rows = parseSqp(payload)

console.log(`\nparsed rows: ${rows.length}`)
const nonZeroOurs = rows.filter((r) => r.impressionsBrand > 0).length
const totalOurImpr = rows.reduce((s, r) => s + r.impressionsBrand, 0)
const totalMarket = rows.reduce((s, r) => s + r.impressionsTotal, 0)
console.log(`rows with our impressions > 0 : ${nonZeroOurs}   (was 0 for all 9,232 prod rows)`)
console.log(`our impressions total          : ${totalOurImpr}`)
console.log(`market impressions total       : ${totalMarket}`)
console.log(`implied impression share       : ${(share(totalOurImpr, totalMarket) * 100).toFixed(2)}%`)

console.log('\ntop 5 queries by our impressions:')
for (const r of [...rows].sort((a, b) => b.impressionsBrand - a.impressionsBrand).slice(0, 5)) {
  console.log(`  ${r.searchQuery.padEnd(38)} ours=${String(r.impressionsBrand).padStart(6)}  market=${String(r.impressionsTotal).padStart(7)}  share=${(share(r.impressionsBrand, r.impressionsTotal) * 100).toFixed(2)}%  clicks=${r.clicksBrand}  purch=${r.purchasesBrand}`)
}

// Cross-check one row against the raw JSON so the numbers are provably not invented.
const raw = payload.dataByAsin[0]
const parsed = rows.find((r) => r.searchQuery === raw.searchQueryData.searchQuery)
console.log('\ncross-check row 0:')
console.log(`  raw  asinImpressionCount=${raw.impressionData.asinImpressionCount} totalQueryImpressionCount=${raw.impressionData.totalQueryImpressionCount}`)
console.log(`  parsed impressionsBrand=${parsed?.impressionsBrand} impressionsTotal=${parsed?.impressionsTotal}`)
console.log(`  match: ${parsed?.impressionsBrand === raw.impressionData.asinImpressionCount && parsed?.impressionsTotal === raw.impressionData.totalQueryImpressionCount ? 'YES' : 'NO'}`)

// Amazon also ships its own share, as a PERCENT — confirm ours agrees once scaled.
const amzShare = raw.impressionData.asinImpressionShare
const ourShare = share(parsed!.impressionsBrand, parsed!.impressionsTotal) * 100
console.log(`\n  Amazon asinImpressionShare = ${amzShare}%  ·  computed = ${ourShare.toFixed(2)}%  ⇒ ${Math.abs(amzShare - ourShare) < 0.05 ? 'agree' : 'DISAGREE'}`)
console.log('  (Amazon reports share as a percent; we store 0..1 computed from counts — do not store theirs raw.)\n')
