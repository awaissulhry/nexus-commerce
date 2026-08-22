import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
const out: any = {}

// A. Suppression exposure among the targets a KT/Bid/SOV rule's bid_apply could touch.
//    bid_apply's floor is max(0.05, minEur) — it can NEVER write <=3c, so any op on a
//    suppressed target un-suppresses it.
out.suppressionExposure = (await q(`
  SELECT count(*)::int positive_keyword_targets,
         count(*) FILTER (WHERE t."bidCents" <= 3)::int at_or_below_3c,
         count(*) FILTER (WHERE t."suppressedFromBidCents" IS NOT NULL)::int flagged,
         count(*) FILTER (WHERE t."bidCents" <= 3 AND t."suppressedFromBidCents" IS NULL)::int low_but_unflagged,
         count(*) FILTER (WHERE t."suppressedFromBidCents" IS NOT NULL AND t."bidCents" > 3)::int flagged_but_not_low
  FROM "AdTarget" t WHERE t.kind='KEYWORD' AND t."isNegative"=false`))[0]
out.campaignsSuppressedNow = (await q(`
  SELECT count(*)::int total, count(*) FILTER (WHERE "bidsSuppressedAt" IS NOT NULL)::int suppressed_now
  FROM "Campaign"`))[0]

// B. What the /advertising/targets?limit=1500 preview feed actually contains, by kind.
//    (the preview renders the first 100 of the in-scope rows, whatever kind they are)
out.targetsFeedByKind = await q(`
  SELECT kind, count(*)::int n, count(*) FILTER (WHERE "isNegative")::int negatives
  FROM "AdTarget" GROUP BY 1 ORDER BY 2 DESC`)

// C. SQP joinability at TARGET grain (cross-check SOV-P's 946) — the honest alternative source
out.sqpTargetCoverage = (await q(`
  WITH latest AS (SELECT max("startDate") d FROM "SearchQueryPerformance"),
       s1 AS (SELECT DISTINCT lower(trim("searchQuery")) kw, "marketplace" mkt
              FROM "SearchQueryPerformance" WHERE "startDate" = (SELECT d FROM latest)),
       s2 AS (SELECT DISTINCT lower(trim("searchQuery")) kw, "marketplace" mkt
              FROM "SearchQueryPerformance" WHERE "startDate" >= (SELECT d FROM latest) - 7),
       t AS (SELECT t.id, lower(trim(t."expressionValue")) kw, c."marketplace" mkt
             FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
             WHERE t.kind='KEYWORD' AND t."isNegative"=false AND t."expressionValue" IS NOT NULL)
  SELECT (SELECT count(*)::int FROM t) targets,
         (SELECT count(*)::int FROM t JOIN s1 USING (kw,mkt)) covered_latest_week,
         (SELECT count(*)::int FROM t JOIN s2 USING (kw,mkt)) covered_two_weeks,
         (SELECT d::text FROM latest) latest_period`))[0]
out.sqpTargetCoverageByMarket = await q(`
  WITH latest AS (SELECT max("startDate") d FROM "SearchQueryPerformance"),
       s AS (SELECT DISTINCT lower(trim("searchQuery")) kw, "marketplace" mkt
             FROM "SearchQueryPerformance" WHERE "startDate" = (SELECT d FROM latest)),
       t AS (SELECT t.id, lower(trim(t."expressionValue")) kw, c."marketplace" mkt
             FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
             WHERE t.kind='KEYWORD' AND t."isNegative"=false AND t."expressionValue" IS NOT NULL)
  SELECT t.mkt, count(*)::int targets, count(s.kw)::int covered
  FROM t LEFT JOIN s ON s.kw=t.kw AND s.mkt=t.mkt GROUP BY 1 ORDER BY 2 DESC`)

// D. Has the KEYWORD_RANK_BID trigger ever produced an execution?
out.ktExecutions = (await q(`
  SELECT count(*)::int rows FROM "AutomationRuleExecution" e
  JOIN "AutomationRule" r ON r.id = e."ruleId" WHERE r.trigger = 'KEYWORD_RANK_BID'`))[0]
out.everKtRule = (await q(`SELECT count(*)::int FROM "AutomationRule" WHERE trigger='KEYWORD_RANK_BID'`))[0]

// E. The KT.7 propose→apply path — still-live records
out.ktProposals = (await q(`SELECT count(*)::int rows FROM "KeywordBidProposal"`))[0]
out.watchlists = (await q(`
  SELECT (SELECT count(*)::int FROM "KeywordWatchlist") lists,
         (SELECT count(*)::int FROM "KeywordWatchlistTerm") terms`))[0]

await prisma.$disconnect()
console.log('===JSON===' + JSON.stringify(out, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 1))
