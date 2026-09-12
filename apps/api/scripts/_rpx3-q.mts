import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT "searchQuery" AS q, SUM("impressionsTotal")::int AS mkt, SUM("impressionsBrand")::int AS ours,
    ROUND((SUM("impressionsBrand")::numeric/NULLIF(SUM("impressionsTotal"),0)*100),2)::text AS shr,
    SUM("clicksBrand")::int AS clk, SUM("purchasesTotal")::int AS mkt_buys, SUM("purchasesBrand")::int AS our_buys
  FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND asin IS NOT NULL AND "startDate"='2026-08-16'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 9`)
for (const x of r) console.log(`${String(x.q).padEnd(34)} mkt=${String(x.mkt).padStart(8)} ours=${String(x.ours).padStart(6)} shr=${String(x.shr).padStart(6)}%  clk=${String(x.clk).padStart(4)}  mktBuys=${String(x.mkt_buys).padStart(4)} ourBuys=${x.our_buys}`)
await prisma.$disconnect()
