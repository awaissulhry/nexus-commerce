/** Reconcile my N6 figure against the reporting session's RPT.11 definition. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const q=(s:string)=>p.$queryRawUnsafe<Record<string,unknown>[]>(s)
const show=(t:string,r:unknown[])=>console.log(`\n=== ${t} ===\n`+JSON.stringify(r,(_k,v)=>typeof v==='bigint'?Number(v):v,1))

show('MINE (naive): zero-order search-term spend, 30d, no maturity or click floor', await q(`
  WITH term AS (
    SELECT "query","marketplace", SUM(clicks)::int AS clicks,
           SUM("costMicros")/1000000.0 AS cost, SUM(COALESCE("sales7dCents",0)) AS sales_cents
    FROM "AmazonAdsSearchTerm" WHERE date > now() - interval '30 days' GROUP BY 1,2)
  SELECT ROUND(SUM(cost) FILTER (WHERE sales_cents=0)::numeric,2) AS wasted_eur,
         COUNT(*) FILTER (WHERE sales_cents=0) AS terms,
         ROUND(SUM(cost)::numeric,2) AS examined_eur
  FROM term`))

show('THEIRS (RPT.11): matured window (-7d) + min 5 clicks', await q(`
  WITH term AS (
    SELECT "query","marketplace", SUM(clicks)::int AS clicks,
           SUM("costMicros")/1000000.0 AS cost, SUM(COALESCE("sales7dCents",0)) AS sales_cents
    FROM "AmazonAdsSearchTerm"
    WHERE date >= (now() - interval '30 days')::date AND date <= (now() - interval '7 days')::date
    GROUP BY 1,2)
  SELECT ROUND(SUM(cost) FILTER (WHERE sales_cents=0 AND clicks>=5)::numeric,2) AS wasted_eur,
         COUNT(*) FILTER (WHERE sales_cents=0 AND clicks>=5) AS terms,
         ROUND(SUM(cost)::numeric,2) AS examined_eur
  FROM term`))

show('what my figure counted that theirs excludes', await q(`
  WITH term AS (
    SELECT "query", SUM(clicks)::int AS clicks, SUM("costMicros")/1000000.0 AS cost,
           SUM(COALESCE("sales7dCents",0)) AS sales_cents, MAX(date) AS last_seen
    FROM "AmazonAdsSearchTerm" WHERE date > now() - interval '30 days' GROUP BY 1)
  SELECT
    ROUND(SUM(cost) FILTER (WHERE sales_cents=0 AND clicks<5)::numeric,2) AS under_5_clicks_eur,
    COUNT(*) FILTER (WHERE sales_cents=0 AND clicks<5) AS under_5_clicks_terms,
    ROUND(SUM(cost) FILTER (WHERE sales_cents=0 AND last_seen > (now()-interval '7 days')::date)::numeric,2) AS unmatured_eur
  FROM term`))
await p.$disconnect()
