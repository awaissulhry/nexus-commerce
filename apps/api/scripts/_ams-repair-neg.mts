/**
 * Zero the impossible negative counters in AmazonAdsHourlyPerformance.
 *
 * These rows are AMS corrections that arrived with no baseline to apply against,
 * so the delta was stored as an absolute count. The true original values were
 * never received and cannot be reconstructed — zeroing makes the totals honest;
 * it does not recover the data.
 *
 * Rows are KEPT, not deleted: each carries a real entityId and hour, and the
 * fact that an adjustment occurred is itself information.
 */
import prisma from '../src/db.js'
const live = process.argv.includes('--live')
const before = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS rows,
         SUM(LEAST("impressions",0))::int AS neg_impr,
         SUM(LEAST("clicks",0))::int AS neg_clicks,
         COUNT(DISTINCT "marketplace")::int AS markets,
         COUNT(DISTINCT "date")::int AS days
  FROM "AmazonAdsHourlyPerformance"
  WHERE "impressions" < 0 OR "clicks" < 0 OR "costMicros" < 0`)
console.error('BEFORE ' + JSON.stringify(before[0]))
if (!live) { console.error('DRY RUN — pass --live to apply'); process.exit(0) }
const n = await prisma.$executeRawUnsafe(`
  UPDATE "AmazonAdsHourlyPerformance"
     SET "impressions" = GREATEST(0, "impressions"),
         "clicks"      = GREATEST(0, "clicks"),
         "costMicros"  = GREATEST(0, "costMicros")
   WHERE "impressions" < 0 OR "clicks" < 0 OR "costMicros" < 0`)
const after = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS still_negative FROM "AmazonAdsHourlyPerformance"
  WHERE "impressions" < 0 OR "clicks" < 0 OR "costMicros" < 0`)
console.error(`REPAIRED rows=${n}`)
console.error('AFTER ' + JSON.stringify(after[0]))
process.exit(0)
