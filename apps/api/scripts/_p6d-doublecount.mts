/** 🔴 READ-ONLY. Every ads reader computes sales as sales7dCents + sales14dCents, which is only
 *  correct because SP writes 0 into the 14d column and SB writes 0 into the 7d one. SPC.1's
 *  widened ingest makes SP write a REAL sales14d. Does that double-count? */
const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('   ' + Object.entries(x).map(([k, v]) => `${k}=${j(v)}`).join('  ')))
console.log('=== SP campaign rows carrying BOTH a 7d and a 14d sales figure ===')
t(await q(`SELECT COUNT(*)::bigint AS rows,
   COUNT(*) FILTER (WHERE "sales7dCents" > 0 AND "sales14dCents" > 0)::bigint AS both_positive,
   COALESCE(SUM("sales7dCents") FILTER (WHERE "sales7dCents" > 0 AND "sales14dCents" > 0),0)::bigint AS sum7d,
   COALESCE(SUM("sales14dCents") FILTER (WHERE "sales7dCents" > 0 AND "sales14dCents" > 0),0)::bigint AS sum14d
 FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS'`))
console.log('\n=== if both are positive, what a reader currently computes vs the truth ===')
t(await q(`SELECT LEFT(c.name,28) AS name, d."date"::text AS day,
   (d."sales7dCents"/100.0)::text AS sales_7d, (d."sales14dCents"/100.0)::text AS sales_14d,
   ((d."sales7dCents"+d."sales14dCents")/100.0)::text AS what_the_reader_sums
 FROM "AmazonAdsDailyPerformance" d JOIN "Campaign" c ON c.id=d."localEntityId"
 WHERE d."entityType"='CAMPAIGN' AND d."adProduct"='SPONSORED_PRODUCTS'
   AND d."sales7dCents" > 0 AND d."sales14dCents" > 0
 ORDER BY d."sales7dCents" DESC LIMIT 6`))
console.log('\n=== how far back does it go, and is it inside the 30-day window the grid reads? ===')
t(await q(`SELECT MIN("date")::text AS first, MAX("date")::text AS last,
   COUNT(*) FILTER (WHERE "date" >= CURRENT_DATE - 30)::bigint AS inside_30d_window
 FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "sales7dCents" > 0 AND "sales14dCents" > 0`))
await prisma.$disconnect()
