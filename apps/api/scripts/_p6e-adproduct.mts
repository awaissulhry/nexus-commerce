/** READ-ONLY. Who actually uses each sales column? The reader fix depends on it. */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('ROW ' + Object.entries(x).map(([k,v]) => `${k}=${j(v)}`).join('  ')))
console.log('every adProduct in AmazonAdsDailyPerformance, all entity types, all time:')
t(await q(`SELECT "adProduct", "entityType", COUNT(*)::bigint AS rows,
   COALESCE(SUM("sales7dCents"),0)::bigint  AS sum_7d,
   COALESCE(SUM("sales14dCents"),0)::bigint AS sum_14d
 FROM "AmazonAdsDailyPerformance" GROUP BY 1,2 ORDER BY 3 DESC`))
console.log('\nis there a single SPONSORED_BRANDS row anywhere?')
t(await q(`SELECT COUNT(*)::bigint AS sb_rows_all_time FROM "AmazonAdsDailyPerformance" WHERE "adProduct"='SPONSORED_BRANDS'`))
console.log('\nand in the OTHER table readers touch (placement report)?')
t(await q(`SELECT "adProduct", COUNT(*)::bigint AS rows FROM "AmazonAdsPlacementReport" GROUP BY 1`).catch(() => []))
await prisma.$disconnect()
