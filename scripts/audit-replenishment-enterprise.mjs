#!/usr/bin/env node
// Comprehensive enterprise /fulfillment/replenishment audit (read-only).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

async function run(label, sql) {
  try {
    const r = await c.query(sql)
    console.log(`\n=== ${label} ===`)
    if (r.rows.length === 0) console.log('(no rows)')
    else console.table(r.rows)
  } catch (e) {
    console.log(`\n=== ${label} (ERROR) ===\n${e.message}`)
  }
}

await run('1. Suppliers', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "isActive" = true) AS active,
         count(DISTINCT country) AS countries,
         AVG("leadTimeDays")::int AS avg_lead_time,
         count(*) FILTER (WHERE "leadTimeStatsUpdatedAt" IS NOT NULL) AS with_variance_stats
  FROM "Supplier"
`)

await run('2. SupplierProduct relationships', `
  SELECT count(*) AS total_links,
         count(DISTINCT "productId") AS products_with_supplier,
         count(DISTINCT "supplierId") AS suppliers_used,
         count(*) FILTER (WHERE "isPrimary" = true) AS primary_links,
         count(*) FILTER (WHERE "casePack" IS NOT NULL) AS with_case_pack,
         count(*) FILTER (WHERE moq > 1) AS with_moq
  FROM "SupplierProduct"
`)

await run('3. ReplenishmentRule (per-product overrides)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "isActive" = true) AS active,
         count(*) FILTER (WHERE "autoTriggerEnabled" = true) AS auto_trigger_on,
         count(*) FILTER (WHERE "preferredSupplierId" IS NOT NULL) AS with_supplier
  FROM "ReplenishmentRule"
`)

await run('4. PurchaseOrder lifecycle (90d)', `
  SELECT status, count(*) AS pos, AVG("totalCents")::int AS avg_cents
  FROM "PurchaseOrder"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
  GROUP BY status
  ORDER BY count(*) DESC
`)

await run('5. PO approval workflow audit (R.7)', `
  SELECT count(*) AS total_pos,
         count(*) FILTER (WHERE "reviewedAt" IS NOT NULL) AS reviewed,
         count(*) FILTER (WHERE "approvedAt" IS NOT NULL) AS approved,
         count(*) FILTER (WHERE "submittedAt" IS NOT NULL) AS submitted,
         count(*) FILTER (WHERE "acknowledgedAt" IS NOT NULL) AS acknowledged,
         count(*) FILTER (WHERE "cancelledAt" IS NOT NULL) AS cancelled
  FROM "PurchaseOrder"
  WHERE "createdAt" > NOW() - INTERVAL '90 days'
`)

await run('6. ReplenishmentRecommendation (R.3 persistence)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE status = 'ACTIVE') AS active,
         count(*) FILTER (WHERE status = 'SUPERSEDED') AS superseded,
         count(*) FILTER (WHERE status = 'ACTED') AS acted,
         count(*) FILTER (WHERE urgency = 'CRITICAL') AS critical_active
  FROM "ReplenishmentRecommendation"
`)

await run('7. ReplenishmentRecommendation by urgency (active only)', `
  SELECT urgency, count(*) AS recs, AVG("reorderQuantity")::int AS avg_qty
  FROM "ReplenishmentRecommendation"
  WHERE status = 'ACTIVE'
  GROUP BY urgency
  ORDER BY count(*) DESC
`)

await run('8. ForecastAccuracy (R.1 MAPE infra)', `
  SELECT count(*) AS rows,
         count(DISTINCT sku) AS unique_skus,
         AVG("absoluteError")::numeric(10,2) AS avg_abs_err,
         AVG("percentError")::numeric(8,2) AS avg_pct_err,
         count(*) FILTER (WHERE "withinBand" = true) AS within_band_count,
         MIN(day) AS oldest_day,
         MAX(day) AS newest_day
  FROM "ForecastAccuracy"
`)

await run('9. ForecastAccuracy by model regime', `
  SELECT "modelRegime", count(*) AS rows, AVG("percentError")::numeric(8,2) AS avg_pct_err
  FROM "ForecastAccuracy"
  GROUP BY "modelRegime"
  ORDER BY count(*) DESC
`)

await run('10. ReplenishmentForecast (the prediction layer)', `
  SELECT count(*) AS rows,
         count(DISTINCT sku) AS unique_skus,
         count(DISTINCT marketplace) AS marketplaces,
         count(*) FILTER (WHERE model = 'HOLT_WINTERS_V1') AS hw,
         count(*) FILTER (WHERE "generationTag" = 'COLD_START') AS cold_start,
         count(*) FILTER (WHERE "generationTag" = 'TRAILING_MEAN_FALLBACK') AS fallback,
         MIN("horizonDay") AS earliest_horizon,
         MAX("horizonDay") AS latest_horizon
  FROM "ReplenishmentForecast"
`)

await run('11. StockoutEvent (R.12 ledger)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "endedAt" IS NULL) AS ongoing,
         AVG("durationDays")::numeric(8,2) AS avg_duration_days,
         SUM("estimatedLostMargin")::int AS total_lost_margin_cents,
         SUM("estimatedLostUnits")::int AS total_lost_units
  FROM "StockoutEvent"
  WHERE "startedAt" > NOW() - INTERVAL '90 days'
`)

await run('12. ForecastModelAssignment (R.16 A/B)', `
  SELECT cohort, count(*) AS skus
  FROM "ForecastModelAssignment"
  GROUP BY cohort
`)

await run('13. ReplenishmentSavedView', `
  SELECT count(*) AS total
  FROM "ReplenishmentSavedView"
`)

await run('14. CronRun status (last 7d, replenishment-related)', `
  SELECT "jobName",
         count(*) AS runs,
         count(*) FILTER (WHERE status = 'success') AS success,
         count(*) FILTER (WHERE status = 'error') AS errors,
         MAX("startedAt") AS most_recent
  FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '7 days'
    AND "jobName" IN ('forecast', 'forecast-accuracy', 'auto-po', 'stockout-detector',
                      'abc-classification', 'lead-time-stats', 'fba-restock-ingestion')
  GROUP BY "jobName"
  ORDER BY "jobName"
`)

await run('15. Sales velocity bucket (last 90d, active SKUs)', `
  WITH velocity AS (
    SELECT p.id, COALESCE(SUM(oi.quantity), 0)::float / 90 AS daily_velocity
    FROM "Product" p
    LEFT JOIN "OrderItem" oi ON oi."productId" = p.id
      AND oi."createdAt" > NOW() - INTERVAL '90 days'
    WHERE p."isParent" = false AND p.status = 'ACTIVE'
    GROUP BY p.id
  )
  SELECT
    count(*) AS total_skus,
    count(*) FILTER (WHERE daily_velocity > 1) AS fast_movers,
    count(*) FILTER (WHERE daily_velocity > 0.1 AND daily_velocity <= 1) AS medium_movers,
    count(*) FILTER (WHERE daily_velocity > 0 AND daily_velocity <= 0.1) AS slow_movers,
    count(*) FILTER (WHERE daily_velocity = 0) AS no_sales
  FROM velocity
`)

await run('16. ABC classification populated?', `
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE "abcClass" IS NOT NULL) AS with_abc,
    count(*) FILTER (WHERE "abcClass" = 'A') AS class_a,
    count(*) FILTER (WHERE "abcClass" = 'B') AS class_b,
    count(*) FILTER (WHERE "abcClass" = 'C') AS class_c
  FROM "Product"
  WHERE "isParent" = false AND status = 'ACTIVE'
`)

await c.end()
