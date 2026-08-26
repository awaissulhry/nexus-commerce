/** READ-ONLY. Is the pct() >100% render bug LIVE now that ad sales are de-overloaded?
 *  Uses the new single definition: headline sales = sales7dCents ONLY. */
const { default: prisma } = await import('../src/db.js')
for (const [label, days] of [['7d', 6], ['30d', 29]] as const) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT c.name,
           (SUM(p."costMicros")/10000)::bigint        AS spend_c,
           SUM(COALESCE(p."sales7dCents",0))::bigint  AS sales_c,
           SUM(COALESCE(p."sales14dCents",0))::bigint AS sales14_c
    FROM "AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c.id = p."localEntityId"
    WHERE p."entityType"='CAMPAIGN' AND p."date" >= '${since}'::date
    GROUP BY c.name HAVING SUM(COALESCE(p."sales7dCents",0)) > 0`)
  const withAcos = rows.map(r => ({ name: String(r.name), frac: Number(r.spend_c) / Number(r.sales_c),
    old: Number(r.spend_c) / (Number(r.sales_c) + Number(r.sales14_c)) }))
  const over = withAcos.filter(r => r.frac > 1).sort((a, b) => b.frac - a.frac)
  console.log(`\n== ${label} window (since ${since}) — ${withAcos.length} campaigns with sales ==`)
  console.log(`   ACoS > 100% (would render as "1.xx%"): ${over.length}`)
  for (const r of over.slice(0, 8)) {
    const rendered = r.frac <= 1 ? (r.frac * 100).toFixed(2) : r.frac.toFixed(2)
    console.log(`     ${r.name.slice(0, 34).padEnd(36)} true ${(r.frac * 100).toFixed(1).padStart(6)}%  renders "${rendered}%"   (pre-fix would have shown ${(r.old * 100).toFixed(1)}%)`)
  }
}
await prisma.$disconnect()
