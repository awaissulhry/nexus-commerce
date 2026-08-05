/** ACR.0.2-bis — did ToS-IS actually land, and is it sane? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(s: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(s, ...a)

const overall = await q<{ rows: bigint; with_is: bigint; min: number; max: number; avg: number; first: Date; last: Date }>(`
  SELECT COUNT(*) AS rows, COUNT("topOfSearchIS") AS with_is,
         MIN("topOfSearchIS")::float8 AS min, MAX("topOfSearchIS")::float8 AS max,
         AVG("topOfSearchIS")::float8 AS avg, MIN(date) AS first, MAX(date) AS last
  FROM "AmazonAdsPlacementReport" WHERE placement = 'Top of Search on-Amazon'`)
const o = overall[0]!
console.log(`\nTop-of-Search rows: ${o.rows} · carrying ToS-IS: ${o.with_is}`)
console.log(`  range ${(o.min * 100).toFixed(2)}% – ${(o.max * 100).toFixed(2)}% · mean ${(o.avg * 100).toFixed(2)}%`)
console.log(`  (a share must sit in 0–100%; anything outside means the %-vs-fraction normalisation is wrong)`)

const top = await q<{ camp: string; days: bigint; avg_is: number; impr: bigint }>(`
  SELECT c.name AS camp, COUNT(*) AS days, AVG(p."topOfSearchIS")::float8 AS avg_is, SUM(p.impressions) AS impr
  FROM "AmazonAdsPlacementReport" p
  JOIN "Campaign" c ON c."externalCampaignId" = p."campaignId" AND c.marketplace = p.marketplace
  WHERE p.placement = 'Top of Search on-Amazon' AND p."topOfSearchIS" IS NOT NULL
  GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 10`)
console.log(`\nHighest top-of-search impression share, by campaign:`)
for (const t of top) console.log(`  ${String(t.camp).slice(0,38).padEnd(40)} ToS-IS ${(t.avg_is*100).toFixed(1).padStart(5)}%  over ${String(t.days).padStart(3)} days · ${Number(t.impr).toLocaleString()} impr`)
await prisma.$disconnect()
