import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { businessContext } = await import('../src/services/advertising/ads-business-context.service.js')
const eur = (v: number) => '€' + v.toLocaleString('en-GB',{minimumFractionDigits:2, maximumFractionDigits:2})
const pct = (v: number|null) => v==null ? '—' : (v*100).toFixed(2)+'%'
const c = await businessContext({ from: '2026-07-05', to: '2026-08-03' })
console.log(`window ${c.window.from} → ${c.window.to} · ${c.elapsedMs}ms\n`)
console.log('MARKET      AD SPEND      AD SALES     TOTAL SALES     ACOS     TACoS    AD SHARE')
const row = (m: typeof c.totals) => console.log(
  `${m.marketplace.padEnd(10)} ${eur(m.adSpend).padStart(11)} ${eur(m.adSales).padStart(13)} ${eur(m.totalSales).padStart(15)} ${pct(m.acos).padStart(8)} ${pct(m.tacos).padStart(8)} ${pct(m.adShare).padStart(9)}`)
row(c.totals); console.log('  ---')
c.byMarket.forEach(row)
console.log(`\nWASTED SPEND: ${eur(c.wasted.amount)} across ${c.wasted.terms} terms = ${(c.wasted.pctOfSpend*100).toFixed(1)}% of spend examined`)
console.log(`  rule: >= ${c.wasted.minClicks} clicks, zero attributed sales, judged only to ${c.wasted.maturedTo}`)
console.log('  worst offenders:')
for (const t of c.wasted.top.slice(0,5)) console.log(`    ${eur(t.spend).padStart(9)}  ${String(t.clicks).padStart(4)} clicks  ${t.marketplace}  "${t.query}"`)
console.log('\nCAVEATS SHIPPED WITH THE NUMBER:')
c.caveats.forEach((x,i)=>console.log(`  ${i+1}. ${x}`))
process.exit(0)
