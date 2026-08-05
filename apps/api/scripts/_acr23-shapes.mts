/**
 * ACR.2.3/2.4/2.2b — data-shape probe before building. READ-ONLY.
 *
 * Answers, on prod, the four things the build depends on:
 *   1. account-wide (term × match) contests, and how many span TWO portfolios
 *   2. AD_TARGET grain: how many days, and does externalTargetId actually join
 *   3. ToS impression share: coverage of topOfSearchIS, and the account's own
 *      measured CTR ratio between Top-of-Search and the rest of the page
 *      (that ratio is the position weight — measured, not invented)
 *   4. SQP parent/child co-occupancy: do two children of one parent ever appear
 *      on the same SERP
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const q = <T>(sql: string, ...args: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...args)
const n = (v: unknown) => Number(v ?? 0)

console.log('\n══ 1. ACCOUNT-WIDE CONTESTS (IT) ══')
const contests = await q<{ campaigns: bigint; portfolios: bigint; groups: bigint }>(`
  WITH g AS (
    SELECT LOWER(t."expressionValue") AS term,
           REPLACE(t."expressionType", '_', '') AS match,
           COUNT(DISTINCT c.id) AS campaigns,
           COUNT(DISTINCT COALESCE(c."portfolioId", 'none')) AS portfolios
    FROM "AdTarget" t
    JOIN "AdGroup" g ON g.id = t."adGroupId"
    JOIN "Campaign" c ON c.id = g."campaignId"
    WHERE c.marketplace = 'IT' AND t.kind = 'KEYWORD'
      AND t."isNegative" = false AND t.status = 'ENABLED'
    GROUP BY 1,2
  )
  SELECT campaigns, portfolios, COUNT(*) AS groups FROM g
  WHERE campaigns >= 2 GROUP BY 1,2 ORDER BY 1 DESC, 2 DESC`)
let totContest = 0, totCross = 0
for (const r of contests) {
  totContest += n(r.groups)
  if (n(r.portfolios) >= 2) totCross += n(r.groups)
  console.log(`  campaigns=${r.campaigns} portfolios=${r.portfolios} → ${r.groups} contested (term × match) groups`)
}
console.log(`  TOTAL contested = ${totContest} · of which cross-portfolio = ${totCross}`)

const ports = await q<{ pid: string; name: string; camps: bigint }>(`
  SELECT COALESCE(c."portfolioId",'(none)') AS pid, COALESCE(p.name,'(no portfolio)') AS name, COUNT(*) AS camps
  FROM "Campaign" c LEFT JOIN "AmazonAdsPortfolio" p ON p."externalPortfolioId" = c."portfolioId"
  WHERE c.marketplace = 'IT' GROUP BY 1,2 ORDER BY 3 DESC`)
console.log('  portfolios in IT:')
for (const p of ports) console.log(`    ${String(p.name).padEnd(28)} ${p.camps} campaigns  (${p.pid})`)

console.log('\n══ 2. AD_TARGET GRAIN ══')
const grain = await q<{ days: bigint; rows: bigint; first: Date; last: Date; joined: bigint }>(`
  SELECT COUNT(DISTINCT d.date) AS days, COUNT(*) AS rows, MIN(d.date) AS first, MAX(d.date) AS last,
         COUNT(*) FILTER (WHERE t.id IS NOT NULL) AS joined
  FROM "AmazonAdsDailyPerformance" d
  LEFT JOIN "AdTarget" t ON t."externalTargetId" = d."entityId"
  WHERE d."entityType" = 'AD_TARGET' AND d.date > now() - interval '31 days'`)
const g0 = grain[0]
console.log(`  ${g0?.rows} rows over ${g0?.days} days (${String(g0?.first).slice(0,10)} → ${String(g0?.last).slice(0,10)}) · ${g0?.joined} join to an AdTarget`)

console.log('\n══ 3. ToS IMPRESSION SHARE ══')
const tos = await q<{ placement: string; rows: bigint; camps: bigint; impr: bigint; clicks: bigint; with_is: bigint; avg_is: number }>(`
  SELECT placement, COUNT(*) AS rows, COUNT(DISTINCT "campaignId") AS camps,
         SUM(impressions) AS impr, SUM(clicks) AS clicks,
         COUNT(*) FILTER (WHERE "topOfSearchIS" IS NOT NULL) AS with_is,
         AVG("topOfSearchIS")::float8 AS avg_is
  FROM "AmazonAdsPlacementReport"
  WHERE date > now() - interval '30 days' AND marketplace = 'IT'
  GROUP BY 1 ORDER BY 4 DESC`)
for (const r of tos) {
  const ctr = n(r.impr) > 0 ? n(r.clicks) / n(r.impr) : 0
  console.log(`  ${String(r.placement).padEnd(26)} impr=${n(r.impr).toLocaleString()} clicks=${r.clicks} CTR=${(ctr*100).toFixed(3)}% · ${r.camps} campaigns · ToS-IS on ${r.with_is}/${r.rows} rows (avg ${r.avg_is != null ? (r.avg_is*100).toFixed(1)+'%' : '—'})`)
}

console.log('\n══ 4. SQP PARENT/CHILD CO-OCCUPANCY ══')
const wk = await q<{ week: string }>(`
  SELECT "startDate"::text AS week FROM "SearchQueryPerformance"
  WHERE marketplace='IT' GROUP BY 1 HAVING SUM("impressionsBrand") > 0 ORDER BY 1 DESC LIMIT 1`)
const week = wk[0]?.week?.slice(0, 10)
console.log(`  newest measured week: ${week}`)
const fam = await q<{ parent: string; parent_name: string; children: bigint; asins: string }>(`
  SELECT COALESCE(p."parentId", p.id) AS parent,
         MAX(par.name) AS parent_name,
         COUNT(DISTINCT p."amazonAsin") AS children,
         STRING_AGG(DISTINCT p."amazonAsin", ',') AS asins
  FROM "Product" p
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
  GROUP BY 1 HAVING COUNT(DISTINCT p."amazonAsin") > 1
  ORDER BY 3 DESC LIMIT 10`)
console.log(`  ${fam.length} parents with >1 distinct ASIN (top 10):`)
for (const f of fam) console.log(`    ${String(f.parent_name ?? f.parent).slice(0,40).padEnd(42)} ${f.children} ASINs`)

const co = await q<{ term: string; parent_name: string; asins: bigint; ours: bigint; mkt: bigint }>(`
  WITH famasin AS (
    SELECT p."amazonAsin" AS asin, COALESCE(p."parentId", p.id) AS parent
    FROM "Product" p WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
  ), multi AS (
    SELECT parent FROM famasin GROUP BY 1 HAVING COUNT(DISTINCT asin) > 1
  )
  SELECT s."searchQuery" AS term, MAX(par.name) AS parent_name,
         COUNT(DISTINCT s.asin) AS asins, SUM(s."impressionsBrand") AS ours, MAX(s."impressionsTotal") AS mkt
  FROM "SearchQueryPerformance" s
  JOIN famasin fa ON fa.asin = s.asin
  JOIN multi m ON m.parent = fa.parent
  LEFT JOIN "Product" par ON par.id = fa.parent
  WHERE s.marketplace='IT' AND s."startDate" = $1::date AND s."impressionsBrand" > 0
  GROUP BY s."searchQuery", fa.parent
  HAVING COUNT(DISTINCT s.asin) > 1
  ORDER BY 3 DESC, 5 DESC LIMIT 15`, week)
console.log(`  terms where ≥2 SIBLING ASINs (same parent) both took impressions: ${co.length} (top 15)`)
for (const c of co) console.log(`    ${String(c.term).slice(0,34).padEnd(36)} siblings=${c.asins} ours=${c.ours} mkt=${n(c.mkt).toLocaleString()} [${String(c.parent_name ?? '').slice(0,24)}]`)

await prisma.$disconnect()
