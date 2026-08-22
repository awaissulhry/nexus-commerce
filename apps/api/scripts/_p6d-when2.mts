const { default: prisma } = await import('../src/db.js')
const q = <T,>(s: string) => prisma.$queryRawUnsafe<T[]>(s)
const j = (v: unknown) => (typeof v === 'bigint' ? Number(v) : String(v))
const t = (r: Array<Record<string, unknown>>) => r.forEach(x => console.log('ROW ' + Object.entries(x).map(([k,v]) => `${k}=${j(v)}`).join('  ')))
console.log('SP rows with a POSITIVE 14d figure — the only ones that inflate anything:')
t(await q(`SELECT DATE_TRUNC('day',"reportedAt")::date::text AS written_on, COUNT(*)::bigint AS rows
 FROM "AmazonAdsDailyPerformance"
 WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS' AND "sales14dCents" > 0
 GROUP BY 1 ORDER BY 1 DESC`))
console.log('\ntotals — harmless zeros vs actual inflation:')
t(await q(`SELECT COUNT(*) FILTER (WHERE "sales14dCents" = 0)::bigint AS zeros_harmless,
   COUNT(*) FILTER (WHERE "sales14dCents" > 0)::bigint AS positive_inflating,
   COUNT(*) FILTER (WHERE "sales14dCents" IS NULL)::bigint AS already_null
 FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "adProduct"='SPONSORED_PRODUCTS'`))
await prisma.$disconnect()
