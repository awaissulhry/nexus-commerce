/** READ-ONLY. Where does Amazon's budget DAY start — 00:00 UTC or local midnight (22:00Z)?
 *  Decisive with data already on disk: for the campaigns where Amazon's percent and our
 *  Rome-day sum disagree, print the per-hour spend around the boundary. */
const { default: prisma } = await import('../src/db.js')
const names = ['GALE BROAD IT', 'IT_DEF_Gale_"Targets=All-Asins"_"AGV"', 'GALE | IT | Phrase | Category', 'XAVIA SLIDERS AUTOMATIC', 'FR_Phrase_8_Keywords', 'DE_Exact_3_Keywords', 'GALE PHRASE DE', 'DE_Auto_Close', 'normal slider broad only', 'IT_Auto_Close_Gale_Misano_Moss']
const camps = await prisma.campaign.findMany({ where: { name: { in: names } }, select: { id: true, name: true, dailyBudget: true } })
for (const c of camps) {
  const rows = await prisma.$queryRawUnsafe<Array<{ d: string; hour: number; eur: number; created: Date }>>(`
    SELECT "date"::text AS d, "hour", (SUM("costMicros")/1e6)::float8 AS eur, MAX("createdAt") AS created
    FROM "AmazonAdsHourlyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "localEntityId"=$1 AND "date" >= CURRENT_DATE - 1
    GROUP BY 1,2 ORDER BY 1,2`, c.id)
  const nz = rows.filter(r => r.eur > 0)
  const since22 = rows.filter(r => (r.d > '2026-08-21') || r.hour >= 22).reduce((s, r) => s + r.eur, 0)
  const since00 = rows.filter(r => r.d === '2026-08-22').reduce((s, r) => s + r.eur, 0)
  console.log(`\n${c.name.slice(0, 34)}  budget=${c.dailyBudget}`)
  console.log(`   hours with spend: ${nz.map(r => `${r.d.slice(5)}h${r.hour}=${r.eur.toFixed(2)}`).join(' ') || '(none)'}`)
  console.log(`   sum since 22:00Z (Rome day) = ${since22.toFixed(2)}   sum since 00:00Z (UTC day) = ${since00.toFixed(2)}`)
}
await prisma.$disconnect()
