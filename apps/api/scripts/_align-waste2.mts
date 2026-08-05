import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))
// The 44 genuinely-wasteful terms, cross-checked against the brand protections
// seeded tonight: a wasted BRAND term is a different problem from a wasted generic.
show('the 44 actionable terms — brand-protected or not?', await q(`
  WITH term AS (
    SELECT lower("query") AS query, "marketplace", SUM(clicks)::int AS clicks,
           SUM("costMicros")/1000000.0 AS cost, SUM(COALESCE("sales7dCents",0)) AS sales_cents
    FROM "AmazonAdsSearchTerm"
    WHERE date >= (now() - interval '30 days')::date AND date <= (now() - interval '7 days')::date
    GROUP BY 1,2),
  wasted AS (SELECT * FROM term WHERE sales_cents=0 AND clicks>=5)
  SELECT EXISTS (SELECT 1 FROM "AdKeywordProtection" k
                 WHERE k.mode='WHITELIST' AND w.query LIKE '%'||k.term||'%') AS brand_protected,
         COUNT(*) AS terms, ROUND(SUM(w.cost)::numeric,2) AS eur
  FROM wasted w GROUP BY 1 ORDER BY 3 DESC`))
show('top 10 wasted terms (the negation shortlist)', await q(`
  SELECT lower("query") AS query, "marketplace", SUM(clicks)::int AS clicks,
         ROUND((SUM("costMicros")/1000000.0)::numeric,2) AS eur
  FROM "AmazonAdsSearchTerm"
  WHERE date >= (now() - interval '30 days')::date AND date <= (now() - interval '7 days')::date
  GROUP BY 1,2 HAVING SUM(COALESCE("sales7dCents",0))=0 AND SUM(clicks)>=5
  ORDER BY 4 DESC LIMIT 10`))
await p.$disconnect()
