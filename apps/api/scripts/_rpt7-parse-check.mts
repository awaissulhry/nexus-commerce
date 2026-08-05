import { resolve } from 'path'
import { readFileSync } from 'fs'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { parseUnifiedReport } = await import('../src/services/advertising/ads-console-import.service.js')

const text = readFileSync('/Users/awais/Downloads/Campaign_-_07_29_2026T04_39_35.csv', 'utf8')
const t0 = Date.now()
const p = parseUnifiedReport(text)
const eur = (c: number) => '€' + (c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })

console.log(`parsed in ${Date.now() - t0}ms`)
console.log(`  rows read      : ${p.rowsRead.toLocaleString('en-GB')}`)
console.log(`  rows merged    : ${p.rowsMerged}  (traffic + conversion lines folded)`)
console.log(`  rows stored    : ${p.rows.length.toLocaleString('en-GB')}`)
console.log(`  skipped        : ${p.rowsSkipped}   errors: ${p.errors.length}`)
console.log(`  window         : ${p.windowStart} → ${p.windowEnd}`)
console.log(`\nTOTALS (must match the independent scan of this file)`)
console.log(`  impressions    : ${p.totals.impressions.toLocaleString('en-GB')}   expected 5,871,130`)
console.log(`  clicks         : ${p.totals.clicks.toLocaleString('en-GB')}`)
console.log(`  spend          : ${eur(p.totals.costCents)}   expected €12,629.12`)
console.log(`  sales          : ${eur(p.totals.salesCents)}   expected €55,856.03`)
console.log(`  purchases      : ${p.totals.purchases}   expected 633`)
console.log(`  ACOS           : ${(100 * p.totals.costCents / p.totals.salesCents).toFixed(2)}%   expected 22.61%`)

console.log('\nTRAP CHECKS')
console.log('  2 Excel-escaped ids stripped :', p.rows.every(r => !r.campaignId.includes('=')) ? 'ok' : 'FAIL')
console.log('  4 marketplaces normalised    :', [...new Set(p.rows.map(r => r.marketplace))].sort().join('/'))
console.log('  1 windows are spans          :', [...new Set(p.rows.map(r => `${r.windowStart}→${r.windowEnd}`))].length, 'distinct windows')
const multi = p.rows.filter(r => r.sourceRows > 1)
console.log('  7 folded rows                :', multi.length, '· example:',
  multi[0] ? `${multi[0].clicks} clicks + ${multi[0].purchases} purchase / ${eur(multi[0].salesCents)} sales in one row` : 'none')
console.log('  5 portfolio -1 → null        :', p.rows.some(r => r.portfolioName === null) ? 'ok' : 'n/a')
console.log('  searchTerm present           :', p.rows.filter(r => r.searchTerm).length.toLocaleString('en-GB'))
console.log('  distinct search terms        :', new Set(p.rows.map(r => r.searchTerm)).size.toLocaleString('en-GB'), ' expected 9,368')
process.exit(0)
