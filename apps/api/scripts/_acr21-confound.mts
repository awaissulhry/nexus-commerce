/**
 * ACR.2.1 — does bidding actually LOWER our share, or is that a Simpson's paradox?
 *
 * The headline comparison says: 112 targeted terms average 0.53% share, 476 untargeted terms
 * average 1.87%. Read naively that says our own bidding suppresses us, which would be absurd.
 * The obvious confound is market size — we bid on the head, and a share of a small market is
 * easy. This splits by market size so the two populations are compared like for like.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

const WEEK = (await q<{ w: string }>(`
  SELECT "startDate"::text AS w FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND "impressionsBrand" > 0 GROUP BY 1 ORDER BY 1 DESC LIMIT 1`))[0].w.slice(0, 10)

const BUCKETS = `CASE
  WHEN x.m >= 100000 THEN 'a 100k+'
  WHEN x.m >= 25000  THEN 'b 25k-100k'
  WHEN x.m >= 5000   THEN 'c 5k-25k'
  WHEN x.m >= 1000   THEN 'd 1k-5k'
  ELSE 'e under 1k' END`

h(`IT week ${WEEK} — CORRECTED: per-term market counted once, split by whether we bid`)
show(await q(`
  WITH t AS (
    SELECT LOWER(t."expressionValue") AS term FROM "AdTarget" t
    JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND t.kind='KEYWORD' AND t."isNegative"=false
    GROUP BY 1
  ), x AS (
    SELECT LOWER(s."searchQuery") AS term, MAX(s."impressionsTotal") AS m, SUM(s."impressionsBrand") AS o
    FROM "SearchQueryPerformance" s
    WHERE s.marketplace='IT' AND s."startDate"='${WEEK}'
    GROUP BY 1
  )
  SELECT ${BUCKETS} AS market_size,
         (t.term IS NOT NULL) AS we_bid,
         COUNT(*)::int AS terms,
         ROUND((100.0*SUM(x.o)/NULLIF(SUM(x.m),0))::numeric,3) AS pooled_share_pct
  FROM x LEFT JOIN t ON t.term = x.term
  GROUP BY 1,2 ORDER BY 1, 2 DESC`), 20)

h('pooled overall, corrected')
show(await q(`
  WITH t AS (
    SELECT LOWER(t."expressionValue") AS term FROM "AdTarget" t
    JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND t.kind='KEYWORD' AND t."isNegative"=false
    GROUP BY 1
  ), x AS (
    SELECT LOWER(s."searchQuery") AS term, MAX(s."impressionsTotal") AS m, SUM(s."impressionsBrand") AS o
    FROM "SearchQueryPerformance" s
    WHERE s.marketplace='IT' AND s."startDate"='${WEEK}'
    GROUP BY 1
  )
  SELECT (t.term IS NOT NULL) AS we_bid, COUNT(*)::int AS terms,
         SUM(x.m)::bigint AS market_impr, SUM(x.o)::bigint AS our_impr,
         ROUND((100.0*SUM(x.o)/NULLIF(SUM(x.m),0))::numeric,3) AS pooled_share_pct
  FROM x LEFT JOIN t ON t.term = x.term
  GROUP BY 1 ORDER BY 1 DESC`))

await p.$disconnect()
