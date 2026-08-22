const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('ROW ' + Object.entries(x).map(([k,v]) => `${k}=${j(v)}`).join('  ')))
console.log('when were the bad SP rows last WRITTEN (reportedAt)?')
t(await q(`SELECT DATE_TRUNC('day',"reportedAt")::date::text AS reported_on, COUNT(*)::bigint AS rows
 FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "sales14dCents" IS NOT NULL
 GROUP BY 1 ORDER BY 1 DESC LIMIT 6`))
console.log('and how many were touched since the last deploy of the OLD ingest?')
t(await q(`SELECT COUNT(*)::bigint AS written_today
 FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "sales14dCents" IS NOT NULL
   AND "reportedAt" >= CURRENT_DATE`))
await prisma.$disconnect()
