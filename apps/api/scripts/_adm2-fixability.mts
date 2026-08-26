/** ADM.2 — for each EMPTY column, is the data actually in the DB? (fixable vs honestly absent) */
import prisma from '../src/db.js'
const W = `"entityType"='CAMPAIGN' AND date >= '2026-08-20' AND date <= '2026-08-26'`
const q = async (label: string, expr: string) => {
  try {
    const r = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int AS rows, COUNT(${expr})::int AS nonnull, SUM(CASE WHEN ${expr} > 0 THEN 1 ELSE 0 END)::int AS positive FROM "AmazonAdsDailyPerformance" WHERE ${W}`)
    const x = r[0]
    console.log(`  ${label.padEnd(26)} rows=${String(x.rows).padStart(5)} nonNull=${String(x.nonnull).padStart(5)} >0=${String(x.positive).padStart(5)} ${x.nonnull === 0 ? '<-- NO DATA' : x.positive === 0 ? '<-- all zero' : '<-- HAS DATA'}`)
  } catch (e) { console.log(`  ${label.padEnd(26)} ERR ${(e as Error).message.slice(0, 70)}`) }
}
console.log('=== source data for the columns rendering "unknown"/"—" (window 20-26 Aug) ===')
await q('Sale Units (units7d)', '"units7d"')
await q('SameSKU Sales', '"salesSameSku7dCents"')
await q('SameSKU Orders', '"ordersSameSku7d"')
await q('SameSKU Sale Units', '"unitsSameSku7d"')
await q('sales7dCents (for halo)', '"sales7dCents"')
await q('orders7d', '"orders7d"')
for (const c of ['topOfSearchImpressionShare', 'topOfSearchIS', 'impressionShare', 'viewImpressions', 'viewableImpressions']) {
  const ex = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='AmazonAdsDailyPerformance' AND column_name=$1`, c)
  if (ex[0].n) await q(c, `"${c}"`); else console.log(`  ${c.padEnd(26)} <-- COLUMN DOES NOT EXIST`)
}
console.log('\n=== Campaign guardrail columns (Min/Max Budget) ===')
const g = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows, COUNT("minBudgetCents")::int minset, COUNT("maxBudgetCents")::int maxset, COUNT("minBidCents")::int minbid, COUNT("maxBidCents")::int maxbid FROM "Campaign"`)
console.log(' ', JSON.stringify(g[0]))
console.log('\n=== Rules column: AutomationRule count per campaign? ===')
try {
  const r = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE enabled)::int enabled FROM "AutomationRule"`)
  console.log('  AutomationRule:', JSON.stringify(r[0]))
} catch (e) { console.log('  ', (e as Error).message.slice(0, 80)) }
await prisma.$disconnect()
