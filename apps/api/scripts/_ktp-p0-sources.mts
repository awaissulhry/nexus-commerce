import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (s: string) => prisma.$queryRawUnsafe<any[]>(s)
const out: any = {}

// A. Amazon top-of-search impression share — the only PAID-prominence signal we ingest
out.dailyPerf_tosIS = (await q(`
  SELECT count(*)::int rows,
         count(*) FILTER (WHERE "topOfSearchIS" IS NOT NULL)::int tos_set,
         count(*) FILTER (WHERE "entityType"='AD_TARGET')::int target_rows,
         count(*) FILTER (WHERE "entityType"='AD_TARGET' AND "topOfSearchIS" IS NOT NULL)::int target_tos_set,
         max("date")::text max_date, min("date")::text min_date
  FROM "AmazonAdsDailyPerformance" WHERE "date" > now() - interval '45 days'`))[0]

// B. SQP: query volume + popularity rank (the honest "Search Volume" source)
out.sqp = (await q(`
  SELECT count(*)::int rows,
         count(*) FILTER (WHERE "searchQueryRank" IS NOT NULL)::int rank_set,
         count(*) FILTER (WHERE "searchQueryVolume" > 0)::int volume_set,
         count(DISTINCT "marketplace")::int markets,
         max("startDate")::text max_period
  FROM "SearchQueryPerformance"`))[0]
out.sqp_byMarket = await q(`
  SELECT "marketplace" mkt, max("startDate")::text newest, count(*)::int rows,
         count(*) FILTER (WHERE "searchQueryRank" IS NOT NULL)::int rank_set
  FROM "SearchQueryPerformance" GROUP BY 1 ORDER BY 1`)

// C. Can our keyword TARGETS be joined to SQP by text? (the only bridge that exists)
out.joinability = (await q(`
  WITH t AS (SELECT DISTINCT lower(trim(t."expressionValue")) kw, c."marketplace" mkt
             FROM "AdTarget" t
             JOIN "AdGroup" g ON g.id = t."adGroupId"
             JOIN "Campaign" c ON c.id = g."campaignId"
             WHERE t.kind='KEYWORD' AND t."isNegative"=false AND t."expressionValue" IS NOT NULL),
       s AS (SELECT DISTINCT lower(trim("searchQuery")) kw, "marketplace" mkt FROM "SearchQueryPerformance")
  SELECT (SELECT count(*)::int FROM t) distinct_target_kw,
         (SELECT count(*)::int FROM s) distinct_sqp_kw,
         (SELECT count(*)::int FROM t JOIN s USING (kw, mkt)) matched`))[0]

// D. AmazonAdsBrandMetric — searchImpressionShare (SB-level)
out.brandMetric = (await q(`
  SELECT count(*)::int rows, count(*) FILTER (WHERE "searchImpressionShare" IS NOT NULL)::int sis_set
  FROM "AmazonAdsBrandMetric"`))[0]

// E. The SOV-P neighbour's field — is sovPct anything real, and where does it come from?
out.impressionShareTables = await q(`
  SELECT table_name::text AS table_name FROM information_schema.tables
  WHERE table_schema='public' AND (table_name ILIKE '%share%' OR table_name ILIKE '%rank%') ORDER BY 1`)

// F. Positive keyword targets per market (the population a KT rule would act on)
out.targetsByMarket = await q(`
  SELECT c."marketplace" mkt, count(*)::int targets,
         count(*) FILTER (WHERE t."bidCents" <= 3)::int at_or_below_3c
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t.kind='KEYWORD' AND t."isNegative"=false GROUP BY 1 ORDER BY 2 DESC`)

await prisma.$disconnect()
console.log(JSON.stringify(out, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 1))
