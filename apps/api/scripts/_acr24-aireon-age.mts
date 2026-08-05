/** ACR.2.4 — did AIREON exist during the measured week? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(s: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(s, ...a)

const prod = await q<{ family: string; asins: bigint; first_created: Date; first_pub: Date | null }>(`
  SELECT COALESCE(par.name, p.name) AS family,
         COUNT(DISTINCT p."amazonAsin") AS asins,
         MIN(p."createdAt") AS first_created,
         NULL::timestamp AS first_pub
  FROM "Product" p LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
    AND (par.name ILIKE '%AIREON%' OR par.name ILIKE '%GALE%')
  GROUP BY 1 ORDER BY 3`)
console.log('\nFamily age (catalogue):')
for (const r of prod) console.log(`  ${String(r.family).slice(0,44).padEnd(46)} ${r.asins} ASINs · first created ${String(r.first_created).slice(0,10)}`)

const camp = await q<{ portfolio: string; camps: bigint; first_start: Date | null; spend: number; impr: bigint }>(`
  SELECT COALESCE(pf.name,'(unfiled)') AS portfolio, COUNT(DISTINCT c.id) AS camps,
         MIN(c."startDate") AS first_start,
         COALESCE(SUM(d."costMicros"),0)::float8/1e6 AS spend,
         COALESCE(SUM(d.impressions),0) AS impr
  FROM "Campaign" c
  LEFT JOIN "AmazonAdsPortfolio" pf ON pf."externalPortfolioId" = c."portfolioId"
  LEFT JOIN "AmazonAdsDailyPerformance" d ON d."entityType"='CAMPAIGN' AND d."entityId" = c."externalCampaignId"
       AND d.date BETWEEN '2026-07-19' AND '2026-07-25'
  WHERE c.marketplace='IT' AND (pf.name ILIKE '%AIREON%' OR pf.name ILIKE '%GALE%')
  GROUP BY 1 ORDER BY 1`)
console.log('\nAd activity DURING the measured week (2026-07-19 → 07-25):')
for (const r of camp) console.log(`  ${String(r.portfolio).padEnd(20)} ${r.camps} campaigns · started ${r.first_start ? String(r.first_start).slice(0,10) : '—'} · that week: EUR ${r.spend.toFixed(2)} · ${Number(r.impr).toLocaleString()} impressions`)
await prisma.$disconnect()
