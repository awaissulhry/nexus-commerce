/**
 * ACR.2.1 — what can a coverage scoreboard actually SAY today? READ-ONLY.
 *
 * Measure before modelling. The plan puts `KeywordCoverageSet` first, but a schema written
 * before you know what the read side can answer is a schema you rewrite. This asks the
 * scoreboard's own questions directly against the repaired SQP data and the ads tables, so the
 * model that follows is shaped by what exists rather than by what was hoped for.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 18) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0, 46)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n${'─'.repeat(96)}\n${s}\n${'─'.repeat(96)}`)

const WEEK = (await q<{ w: string }>(`
  SELECT "startDate"::text AS w FROM "SearchQueryPerformance"
  WHERE marketplace='IT' AND "impressionsBrand" > 0
  GROUP BY 1 ORDER BY 1 DESC LIMIT 1`))[0]?.w?.slice(0, 10)

console.log(`\nUsing the newest repaired IT week: ${WEEK ?? '(none repaired yet)'}`)
if (!WEEK) { await p.$disconnect(); process.exit(0) }

h('1. THE SCOREBOARD ROW — per term: market size, our share, what we hold it with')
show(await q(`
  SELECT s."searchQuery" AS term,
         SUM(s."impressionsTotal")::int AS market_impr,
         SUM(s."impressionsBrand")::int AS our_impr,
         ROUND((100.0*SUM(s."impressionsBrand")/NULLIF(SUM(s."impressionsTotal"),0))::numeric,2) AS share_pct,
         COUNT(DISTINCT s.asin)::int AS our_asins,
         SUM(s."purchasesTotal")::int AS market_buys,
         SUM(s."purchasesBrand")::int AS our_buys,
         (SELECT COUNT(DISTINCT t.id) FROM "AdTarget" t
            JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
          WHERE LOWER(t."expressionValue")=LOWER(s."searchQuery") AND c.marketplace='IT'
            AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%')::int AS targets_on_it
  FROM "SearchQueryPerformance" s
  WHERE s.marketplace='IT' AND s."startDate"='${WEEK}'
  GROUP BY 1 HAVING SUM(s."impressionsTotal") > 2000
  ORDER BY SUM(s."impressionsTotal") DESC`), 20)

h('2. HEADROOM — big markets where we are nearly absent AND already bid')
show(await q(`
  SELECT s."searchQuery" AS term,
         SUM(s."impressionsTotal")::int AS market_impr,
         ROUND((100.0*SUM(s."impressionsBrand")/NULLIF(SUM(s."impressionsTotal"),0))::numeric,2) AS share_pct,
         (SELECT COUNT(DISTINCT t.id) FROM "AdTarget" t
            JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
          WHERE LOWER(t."expressionValue")=LOWER(s."searchQuery") AND c.marketplace='IT'
            AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%')::int AS targets_on_it
  FROM "SearchQueryPerformance" s
  WHERE s.marketplace='IT' AND s."startDate"='${WEEK}'
  GROUP BY 1
  HAVING SUM(s."impressionsTotal") > 5000
  ORDER BY (100.0*SUM(s."impressionsBrand")/NULLIF(SUM(s."impressionsTotal"),0)) ASC NULLS LAST`), 15)

h('3. THE COVERAGE QUESTION — terms where MORE THAN ONE of our ASINs appears')
console.log('  This is the whole programme in one query: do several of our products already share a SERP?')
show(await q(`
  SELECT s."searchQuery" AS term,
         COUNT(DISTINCT s.asin)::int AS our_asins,
         SUM(s."impressionsTotal")::int AS market_impr,
         ROUND((100.0*SUM(s."impressionsBrand")/NULLIF(SUM(s."impressionsTotal"),0))::numeric,2) AS combined_share_pct,
         STRING_AGG(DISTINCT s.asin, ',')  AS asins
  FROM "SearchQueryPerformance" s
  WHERE s.marketplace='IT' AND s."startDate"='${WEEK}' AND s."impressionsBrand" > 0
  GROUP BY 1 HAVING COUNT(DISTINCT s.asin) > 1
  ORDER BY COUNT(DISTINCT s.asin) DESC, SUM(s."impressionsTotal") DESC`), 20)

h('4. IS BIDDING WHAT WINS SHARE? terms we target vs terms we do not')
show(await q(`
  WITH t AS (
    SELECT LOWER(t."expressionValue") AS term FROM "AdTarget" t
    JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
    WHERE c.marketplace='IT' AND t.kind='KEYWORD' AND t."expressionType" NOT LIKE 'NEGATIVE%'
    GROUP BY 1
  )
  SELECT (t.term IS NOT NULL) AS we_target_it,
         COUNT(*)::int AS terms,
         ROUND(AVG(100.0*s."impressionsBrand"/NULLIF(s."impressionsTotal",0))::numeric,3) AS avg_share_pct,
         SUM(s."impressionsTotal")::bigint AS market_impr
  FROM "SearchQueryPerformance" s
  LEFT JOIN t ON t.term = LOWER(s."searchQuery")
  WHERE s.marketplace='IT' AND s."startDate"='${WEEK}'
  GROUP BY 1 ORDER BY 1 DESC`))

await p.$disconnect()
console.log('\nDone — read-only.\n')
