/**
 * ACR Stage 5 — 36 of the 70 SB keywords I un-archived are ARCHIVED again within ~2h.
 * Find out what did it, and whether any engine wrote to them. READ-ONLY.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<any[]>(s)
const show = (r: any[]) => r.length
  ? r.forEach(x => console.log('  ' + Object.entries(x).map(([k, v]) => `${k}=${typeof v === 'bigint' ? Number(v) : v}`).join('  ')))
  : console.log('  (none)')

console.log('\n═══ A. When were the SB keyword rows last touched, by status? ═══')
show(await q(`SELECT t.status, COUNT(*)::int AS n,
  MIN(t."updatedAt")::text AS first_touch, MAX(t."updatedAt")::text AS last_touch
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c."adProduct"='SPONSORED_BRANDS' AND t.kind='KEYWORD' AND t."isNegative"=false
  GROUP BY 1 ORDER BY n DESC`))

console.log('\n═══ B. Which MARKETPLACE did the re-archived rows come from? ═══')
show(await q(`SELECT c.marketplace, t.status, COUNT(*)::int AS n
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c."adProduct"='SPONSORED_BRANDS' AND t.kind='KEYWORD' AND t."isNegative"=false
  GROUP BY 1,2 ORDER BY 1,2`))

console.log('\n═══ C. Any AdvertisingActionLog row referencing an SB keyword entity? ═══')
show(await q(`SELECT l."actionType", COUNT(*)::int AS n, MAX(l."createdAt")::text AS last
  FROM "AdvertisingActionLog" l
  WHERE l."createdAt" > timestamp '2026-08-05 20:15:00'
    AND l."entityId" IN (
      SELECT t.id FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
      WHERE c."adProduct"='SPONSORED_BRANDS' AND t.kind='KEYWORD')
  GROUP BY 1 ORDER BY n DESC`))

console.log('\n═══ D. What did the 484 AD_BID_UPDATE rows actually target? (by ad product) ═══')
show(await q(`SELECT COALESCE(c."adProduct",'(unresolved)') AS prod, COUNT(*)::int AS n
  FROM "AdvertisingActionLog" l
  LEFT JOIN "AdTarget" t ON t.id = l."entityId"
  LEFT JOIN "AdGroup" g ON g.id = t."adGroupId"
  LEFT JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE l."actionType"='AD_BID_UPDATE' AND l."createdAt" > timestamp '2026-08-05 20:15:00'
  GROUP BY 1 ORDER BY n DESC`))

console.log('\n═══ E. Structural-reconcile / sync jobs that ran in the window ═══')
show(await q(`SELECT name, status, "startedAt"::text AS started, "finishedAt"::text AS finished,
  LEFT(COALESCE(summary,''), 120) AS summary
  FROM "CronRun" WHERE "startedAt" > timestamp '2026-08-05 20:15:00'
  ORDER BY "startedAt" DESC LIMIT 14`))

await p.$disconnect(); process.exit(0)
