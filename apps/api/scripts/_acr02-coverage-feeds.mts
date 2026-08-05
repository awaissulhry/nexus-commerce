/**
 * ACR.0.2 — why are the two coverage feeds empty? READ-ONLY.
 *
 * RPT.0 measured `topOfSearchIS` as all-null and the SQP brand columns as all-zero,
 * while both crons run on schedule. Running is not producing. These two feeds are the
 * eyes of the whole coverage program, so the cause has to be established before
 * anything is built on them.
 *
 * Hypotheses, cheapest to eliminate first:
 *   H1  placement VOCABULARY mismatch — the ingest UPDATEs rows WHERE placement =
 *       'Top of Search on-Amazon', but the schema documents this column as
 *       TOP_OF_SEARCH | PRODUCT_PAGE | REST_OF_SEARCH | HOME_PAGE. If the writer of
 *       those rows uses the enum vocabulary, updateMany matches 0 rows forever and
 *       reports success. (Same shape as the rule-tab bug fixed 2026-08-05.)
 *   H2  campaignId KEYSPACE mismatch — the report returns Amazon's external id; if
 *       the placement rows are keyed by our local cuid, the join can never match.
 *   H3  DATE mismatch — @db.Date vs a DateTime with a time component.
 *   H4  Amazon isn't returning the column at all (then rowsFetched > 0, withIS = 0).
 *   H5  SQP: total columns land but brand columns are genuinely zero (a real
 *       account fact, not a bug) vs never written at all.
 *
 * The discriminator for H1/H2/H3 is the same as the one that cracked the IT ingest
 * drop: compare what the writer produced against what the reader looks for, rather
 * than trusting either side's own success counter.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr02-coverage-feeds.mts
 * For prod env:  NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_acr02-coverage-feeds.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const table = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '  (none)'
  return rows.map((r) => '  ' + Object.entries(r).map(([k, v]) => `${k}=${n(v)}`).join('  ')).join('\n')
}
const h = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`)

// The literal the ToS-IS ingest matches on (ads-tos-is-ingest.service.ts).
const INGEST_EXPECTS = 'Top of Search on-Amazon'

h('1. AmazonAdsPlacementReport — what placement vocabulary is actually stored?  [H1]')
console.log(table(await q(`
  SELECT placement,
         COUNT(*)                                   AS rows,
         COUNT("topOfSearchIS")                     AS with_tos_is,
         MIN(date)::text                            AS first_day,
         MAX(date)::text                            AS last_day
  FROM "AmazonAdsPlacementReport"
  GROUP BY placement
  ORDER BY rows DESC
`)))
console.log(`\n  The ingest updates WHERE placement = '${INGEST_EXPECTS}'.`)
console.log('  If that string is absent above, H1 is confirmed and nothing else matters.')

h('2. Does the ingest\'s WHERE clause match anything at all?  [H1 decisive]')
console.log(table(await q(`
  SELECT
    (SELECT COUNT(*) FROM "AmazonAdsPlacementReport")                                      AS all_rows,
    (SELECT COUNT(*) FROM "AmazonAdsPlacementReport" WHERE placement = '${INGEST_EXPECTS}') AS rows_ingest_can_reach,
    (SELECT COUNT(*) FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL)     AS rows_with_value
`)))

h('3. campaignId keyspace — external Amazon ids or our local cuids?  [H2]')
console.log(table(await q(`
  SELECT 'placementReport' AS side,
         COUNT(*)                                                              AS rows,
         COUNT(*) FILTER (WHERE "campaignId" ~ '^[0-9]+$')                     AS looks_external_numeric,
         COUNT(*) FILTER (WHERE "campaignId" ~ '^c[a-z0-9]{20,}$')             AS looks_local_cuid
  FROM "AmazonAdsPlacementReport"
  UNION ALL
  SELECT 'campaignTable',
         COUNT(*),
         COUNT(*) FILTER (WHERE "externalCampaignId" ~ '^[0-9]+$'),
         COUNT(*) FILTER (WHERE id ~ '^c[a-z0-9]{20,}$')
  FROM "Campaign"
`)))
console.log(table(await q(`
  SELECT COUNT(DISTINCT pr."campaignId")                                        AS distinct_pr_campaigns,
         COUNT(DISTINCT c."externalCampaignId")                                 AS joinable_by_external_id
  FROM "AmazonAdsPlacementReport" pr
  LEFT JOIN "Campaign" c ON c."externalCampaignId" = pr."campaignId"
`)))

h('4. date column shape — pure dates or timestamps?  [H3]')
console.log(table(await q(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'AmazonAdsPlacementReport' AND column_name IN ('date','topOfSearchIS','campaignId','placement','marketplace')
  ORDER BY column_name
`)))
console.log('  data_type=date ⇒ no time component is possible ⇒ H3 refuted by construction.')

h('5. Is the ToS-IS cron even running, and what does it report?  [H4]')
console.log(table(await q(`
  SELECT "jobName", status, "startedAt"::text AS started,
         COALESCE("outputSummary", "errorMessage", '—') AS detail
  FROM "CronRun"
  WHERE "jobName" ILIKE '%tos%' OR "jobName" ILIKE '%sqp%'
  ORDER BY "startedAt" DESC
  LIMIT 15
`)))
console.log('  rowsFetched>0 with withIS=0  ⇒ H4 (Amazon not returning the column).')
console.log('  withIS>0 with rowsUpdated=0  ⇒ H1/H2/H3 (we fetched it and could not place it).')

h('6. SearchQueryPerformance — are brand columns zero, or is the table empty?  [H5]')
console.log(table(await q(`
  SELECT COUNT(*)                                                  AS rows,
         COUNT(DISTINCT marketplace)                               AS markets,
         MIN("startDate")::text AS first_period, MAX("startDate")::text AS last_period,
         SUM("impressionsTotal")                                   AS impressions_total,
         SUM("impressionsBrand")                                   AS impressions_brand,
         SUM("purchasesTotal")                                     AS purchases_total,
         SUM("purchasesBrand")                                     AS purchases_brand,
         COUNT(*) FILTER (WHERE "impressionsBrand" > 0)            AS rows_with_brand_impr,
         COUNT(*) FILTER (WHERE "asin" IS NOT NULL)                AS asin_level_rows
  FROM "SearchQueryPerformance"
`)))
console.log('  totals>0 with brand=0     ⇒ the report lands but our share columns do not map.')
console.log('  everything 0 / no rows    ⇒ the ingest never wrote; check the cron above.')

h('7. KeywordRank — the coverage program\'s third input')
console.log(table(await q(`
  SELECT COUNT(*) AS rows,
         COUNT(DISTINCT keyword) AS keywords,
         COUNT("organicRank") AS with_organic,
         COUNT("sponsoredRank") AS with_sponsored,
         MAX("capturedAt")::text AS last_capture
  FROM "KeywordRank"
`)))

await p.$disconnect()
console.log('\nDone. Read-only — nothing was written.\n')
