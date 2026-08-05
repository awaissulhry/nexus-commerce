/**
 * ACR.2.4 — which families were ACTUALLY LIVE during the measured week? READ-ONLY.
 *
 * The variation experiment needs a second family on the SAME SERP as GALE. AIREON was the wrong
 * candidate — it launched 07-28, after the week ended — but AIREON was never the only option,
 * and I never checked the others before concluding the experiment was blocked until 2026-08-09.
 *
 * A viable second family needs three things, all checkable here:
 *   1. ad spend/impressions INSIDE 2026-07-19 → 07-25 (so it could appear at all)
 *   2. ASINs in the catalogue to request reports for
 *   3. a distinct Amazon parentAsin from GALE's B0F7J163XJ (else it is not a second family)
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(s: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(s, ...a)

console.log('\n══ Ad activity INSIDE the measured week, by portfolio (IT) ══')
const act = await q<{ portfolio: string; camps: bigint; spend: number; impr: bigint }>(`
  SELECT COALESCE(pf.name, '(unfiled)') AS portfolio,
         COUNT(DISTINCT c.id) AS camps,
         COALESCE(SUM(d."costMicros"), 0)::float8 / 1e6 AS spend,
         COALESCE(SUM(d.impressions), 0) AS impr
  FROM "Campaign" c
  LEFT JOIN "AmazonAdsPortfolio" pf ON pf."externalPortfolioId" = c."portfolioId"
  JOIN "AmazonAdsDailyPerformance" d
    ON d."entityType" = 'CAMPAIGN' AND d."entityId" = c."externalCampaignId"
   AND d.date BETWEEN '2026-07-19' AND '2026-07-25'
  WHERE c.marketplace = 'IT'
  GROUP BY 1 HAVING SUM(d.impressions) > 0
  ORDER BY 4 DESC`)
for (const r of act) {
  console.log(`  ${String(r.portfolio).padEnd(26)} ${String(r.camps).padStart(2)} campaigns · EUR ${r.spend.toFixed(2).padStart(7)} · ${Number(r.impr).toLocaleString().padStart(9)} impressions`)
}

console.log('\n══ Which ASINs did those live campaigns advertise, and whose family are they? ══')
const asins = await q<{ family: string; parent_asin: string; asins: bigint; impr: bigint; in_sqp: bigint }>(`
  WITH live AS (
    SELECT DISTINCT pa.asin
    FROM "Campaign" c
    JOIN "AdGroup" g ON g."campaignId" = c.id
    JOIN "AdProductAd" pa ON pa."adGroupId" = g.id
    JOIN "AmazonAdsDailyPerformance" d
      ON d."entityType" = 'CAMPAIGN' AND d."entityId" = c."externalCampaignId"
     AND d.date BETWEEN '2026-07-19' AND '2026-07-25'
    WHERE c.marketplace = 'IT' AND pa.asin IS NOT NULL AND d.impressions > 0
  )
  SELECT COALESCE(par.name, p.name) AS family,
         COALESCE(MAX(p."parentAsin"), '(null)') AS parent_asin,
         COUNT(DISTINCT live.asin) AS asins,
         0::bigint AS impr,
         COUNT(DISTINCT s.asin) AS in_sqp
  FROM live
  JOIN "Product" p ON p."amazonAsin" = live.asin AND p."deletedAt" IS NULL
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  LEFT JOIN "SearchQueryPerformance" s
    ON s.asin = live.asin AND s.marketplace = 'IT'
   AND s."startDate" = '2026-07-19'::date AND s."impressionsBrand" > 0
  GROUP BY 1 ORDER BY 3 DESC`)
for (const r of asins) {
  const gale = r.parent_asin === 'B0F7J163XJ'
  console.log(`  ${String(r.family).slice(0, 42).padEnd(44)} parent=${String(r.parent_asin).padEnd(12)} ${String(r.asins).padStart(3)} advertised ASINs · ${r.in_sqp} already measured${gale ? '   ← GALE, the family we already have' : ''}`)
}

console.log('\n  A viable control = a NON-GALE parent above with advertised ASINs and 0 already measured.')
await prisma.$disconnect()
