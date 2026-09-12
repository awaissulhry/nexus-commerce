/** ADM.10 — what does the fact table actually hold at AD_GROUP / AD_TARGET / PRODUCT_AD grain? */
import prisma from '../src/db.js'
const types = await prisma.$queryRawUnsafe<any[]>(`SELECT "entityType"::text AS t, COUNT(*)::int n, MAX(date) AS last FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
console.log('=== rows by entityType ===')
for (const r of types) console.log(`  ${String(r.t).padEnd(12)} n=${String(r.n).padStart(6)} last=${r.last?.toISOString?.().slice(0,10)}`)

const check = ['units7d','salesSameSku7dCents','ordersSameSku7d','unitsSameSku7d','ntbOrders14d','ntbSalesCents14d','viewableImpressions','sales7dCents','orders7d','impressions']
for (const t of types.map(r=>r.t)) {
  console.log(`\n=== ${t} — which metric columns are alive? ===`)
  const parts = check.map(c => `COUNT("${c}")::int AS "nn_${c}", SUM(CASE WHEN "${c}"<>0 THEN 1 ELSE 0 END)::int AS "nz_${c}"`).join(', ')
  const r = (await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows, ${parts} FROM "AmazonAdsDailyPerformance" WHERE "entityType"=$1`, t))[0]
  for (const c of check) {
    const nn = r[`nn_${c}`], nz = r[`nz_${c}`]
    const verdict = nn === 0 ? 'ALWAYS NULL' : nz === 0 ? 'all zero' : `ALIVE (${nz} non-zero)`
    console.log(`  ${c.padEnd(22)} ${verdict}`)
  }
}
await prisma.$disconnect()
