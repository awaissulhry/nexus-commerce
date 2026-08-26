/** Coverage Ledger SP-1 — ground truth for the campaign report. READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const q = <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)
const j = (x: unknown) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? Number(v) : v)

console.log('CAMPAIGN rows:', j(await q(`
  SELECT COUNT(*)::int rows, COUNT(DISTINCT "entityId")::int campaigns,
         MIN("date")::text first, MAX("date")::text last,
         COUNT(*) FILTER (WHERE "localEntityId" IS NULL)::int unlinked
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'`)))

console.log('by market:', j(await q(`
  SELECT "marketplace", COUNT(*)::int rows, MAX("date")::text last
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' GROUP BY 1 ORDER BY 2 DESC`)))

console.log('window fields non-zero:', j(await q(`
  SELECT COUNT(*) FILTER (WHERE "sales1dCents" <> 0)::int s1,
         COUNT(*) FILTER (WHERE "sales7dCents" <> 0)::int s7,
         COUNT(*) FILTER (WHERE "sales14dCents" <> 0)::int s14,
         COUNT(*) FILTER (WHERE "sales30dCents" <> 0)::int s30,
         COUNT(*) FILTER (WHERE "orders7d" <> 0)::int o7,
         COUNT(*) FILTER (WHERE "units7d" <> 0)::int u7,
         COUNT(*) FILTER (WHERE "acos7d" IS NOT NULL)::int acos,
         COUNT(*)::int total
  FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN'`)))

console.log('campaigns:', j(await q(`
  SELECT COUNT(*)::int total,
         COUNT(*) FILTER (WHERE "portfolioId" IS NOT NULL)::int with_pf,
         COUNT(*) FILTER (WHERE "externalCampaignId" IS NOT NULL)::int with_ext,
         COUNT(*) FILTER (WHERE "status"='ENABLED')::int enabled
  FROM "Campaign"`)))
console.log('portfolios:', j(await q(`SELECT COUNT(*)::int n FROM "AmazonAdsPortfolio"`)))
console.log('product lines (parents advertised):', j(await q(`
  SELECT COUNT(DISTINCT COALESCE(pr."parentId", pr."id"))::int lines,
         COUNT(DISTINCT ag."campaignId")::int campaigns
  FROM "AdProductAd" a JOIN "AdGroup" ag ON ag."id"=a."adGroupId"
  JOIN "Product" pr ON pr."id"=a."productId" WHERE a."productId" IS NOT NULL`)))
console.log('placement topOfSearchIS:', j(await q(`
  SELECT COUNT(*)::int rows, COUNT("topOfSearchIS")::int with_is, MAX("date")::text last
  FROM "AmazonAdsPlacementReport"`)))
console.log('daily perf total rows:', j(await q(`SELECT COUNT(*)::int n FROM "AmazonAdsDailyPerformance"`)))
await prisma.$disconnect()
