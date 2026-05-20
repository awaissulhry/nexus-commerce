#!/usr/bin/env node
// Phase 2 wipe + Phase 2a exports for the 2026-05-20 data wipe + backfill.
//
// SAFETY:
//   - Defaults to --dry-run (transaction is ROLLED BACK at the end).
//   - Requires explicit --execute to COMMIT.
//   - Pre-flight exports always run (idempotent CSV/JSON to /tmp).
//   - Canary check runs INSIDE the transaction; if it fails, the script
//     ROLLBACKs even with --execute.
//
// Usage:
//   node scripts/data-wipe-2026-05-20-execute.mjs           # dry-run
//   node scripts/data-wipe-2026-05-20-execute.mjs --execute # commits

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const EXECUTE = process.argv.includes('--execute')
const EXPORT_DIR = '/tmp/data-wipe-2026-05-20'
fs.mkdirSync(EXPORT_DIR, { recursive: true })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
const banner = (msg) => console.log(`\n━━━ ${msg} ${'━'.repeat(Math.max(0, 60 - msg.length))}`)

// ───────────────────────────────────────────────────────────────────
// Phase 2a — Pre-flight exports (idempotent, before transaction)
// ───────────────────────────────────────────────────────────────────
banner('Phase 2a: Pre-flight exports')

async function exportTableToCsv(label, sql, filename) {
  try {
    const r = await c.query(sql)
    if (r.rows.length === 0) {
      log(`  ${label}: 0 rows — skipping export`)
      return
    }
    const cols = Object.keys(r.rows[0])
    const header = cols.join(',')
    const csv = r.rows.map(row => cols.map(k => {
      const v = row[k]
      if (v === null || v === undefined) return ''
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s
    }).join(',')).join('\n')
    fs.writeFileSync(path.join(EXPORT_DIR, filename), header + '\n' + csv + '\n')
    log(`  ${label}: ${r.rows.length} rows → ${filename}`)
  } catch (e) {
    log(`  ${label}: FAILED — ${e.message}`)
  }
}

async function exportTableToJson(label, sql, filename) {
  try {
    const r = await c.query(sql)
    fs.writeFileSync(path.join(EXPORT_DIR, filename), JSON.stringify(r.rows, null, 2))
    log(`  ${label}: ${r.rows.length} rows → ${filename}`)
  } catch (e) {
    log(`  ${label}: FAILED — ${e.message}`)
  }
}

await exportTableToCsv(
  'SyncHealthLog (full, preserve 102 AMAZON conflict baseline)',
  `SELECT * FROM "SyncHealthLog" ORDER BY "createdAt" DESC`,
  'sync-health-log.csv'
)

await exportTableToJson(
  'OutboundSyncQueue PENDING (drain spot-check)',
  `SELECT * FROM "OutboundSyncQueue" WHERE "syncStatus" = 'PENDING' ORDER BY "createdAt" DESC LIMIT 500`,
  'outbound-sync-queue-pending.json'
)

await exportTableToCsv(
  'OutboundSyncQueue all (count snapshot by status)',
  `SELECT "syncStatus", count(*) AS rows FROM "OutboundSyncQueue" GROUP BY "syncStatus"`,
  'outbound-sync-queue-status-counts.csv'
)

await exportTableToCsv(
  'CronRun last 7 days (preserved, but exported as backup)',
  `SELECT "jobName", status, count(*) AS runs, max("startedAt") AS last_run
   FROM "CronRun" WHERE "startedAt" > NOW() - INTERVAL '7 days'
   GROUP BY "jobName", status ORDER BY max("startedAt") DESC`,
  'cron-run-last-7d-summary.csv'
)

await exportTableToCsv(
  'ChannelConnection (pre-wipe snapshot for the 7 abandoned eBay rows)',
  `SELECT id, "channelType", marketplace, "managedBy", "displayName",
          ("accessToken" IS NOT NULL) AS has_access_token,
          ("refreshToken" IS NOT NULL) AS has_refresh_token,
          "createdAt"
   FROM "ChannelConnection" ORDER BY "channelType", "createdAt"`,
  'channel-connection-snapshot.csv'
)

await exportTableToCsv(
  'ChannelListing eBay stubs (the 4 NULL-externalListingId rows we are dropping)',
  `SELECT id, channel, marketplace, "productId", "externalListingId", title, "createdAt"
   FROM "ChannelListing"
   WHERE channel = 'EBAY' AND "externalListingId" IS NULL`,
  'channel-listing-ebay-stubs.csv'
)

log('Pre-flight exports complete.')

// ───────────────────────────────────────────────────────────────────
// Phase 2b/c/d — Wipe transaction (with canary check)
// ───────────────────────────────────────────────────────────────────
banner(`Phase 2: Wipe transaction (${EXECUTE ? 'COMMIT' : 'DRY-RUN — will ROLLBACK'})`)

// Tables to delete, in FK-safe child→parent order.
// Each entry: [label, SQL, expectedMaxRows? (used as sanity check)]
const wipePlan = [
  // ── Logs / telemetry (no FKs from data tables; safe to wipe first)
  ['WizardStepEvent', `DELETE FROM "WizardStepEvent"`],
  // AuditLog (129 rows) PRESERVED — immutability trigger from L.6.0 blocks
  // DELETE without superuser. Compliance record stays as designed.
  ['SyncLog', `DELETE FROM "SyncLog"`],
  ['SyncLogErrorGroup', `DELETE FROM "SyncLogErrorGroup"`],
  ['SyncError', `DELETE FROM "SyncError"`],
  ['SyncHealthLog', `DELETE FROM "SyncHealthLog"`],
  ['AiUsageLog', `DELETE FROM "AiUsageLog"`],
  ['AlertEvent', `DELETE FROM "AlertEvent"`],
  ['RateLimitLog', `DELETE FROM "RateLimitLog"`],
  ['TrackingEvent', `DELETE FROM "TrackingEvent"`],
  ['TrackingMessageLog', `DELETE FROM "TrackingMessageLog"`],
  ['WebhookEvent', `DELETE FROM "WebhookEvent"`],
  ['LoginEvent', `DELETE FROM "LoginEvent"`],
  ['FlatFilePullRecord', `DELETE FROM "FlatFilePullRecord"`],
  ['FlatFilePullJob', `DELETE FROM "FlatFilePullJob"`],
  ['RepricingDecision', `DELETE FROM "RepricingDecision"`],
  // Decision #4: keep last 7 days of CronRun
  ['CronRun (>7d old)', `DELETE FROM "CronRun" WHERE "startedAt" < NOW() - INTERVAL '7 days'`],

  // ── Analytics aggregates (derivable from real data on next ingest)
  ['DailySalesAggregate', `DELETE FROM "DailySalesAggregate"`],
  ['ProductProfitDaily', `DELETE FROM "ProductProfitDaily"`],
  ['FbaStorageAge', `DELETE FROM "FbaStorageAge"`],
  ['ListingQualitySnapshot', `DELETE FROM "ListingQualitySnapshot"`],
  ['ListingReconciliation', `DELETE FROM "ListingReconciliation"`],
  ['ForecastAccuracy', `DELETE FROM "ForecastAccuracy"`],

  // ── Outbound queue (decision #2: pre-exported to JSON above)
  ['OutboundApiCallLog', `DELETE FROM "OutboundApiCallLog"`],
  ['OutboundSyncQueue', `DELETE FROM "OutboundSyncQueue"`],

  // ── Advertising (children → parents; sandbox-only data)
  ['AmazonAdsDailyPerformance', `DELETE FROM "AmazonAdsDailyPerformance"`],
  ['AmazonAdsSearchTerm', `DELETE FROM "AmazonAdsSearchTerm"`],
  ['AmazonAdsPlacementReport', `DELETE FROM "AmazonAdsPlacementReport"`],
  ['AmazonAdsBrandMetric', `DELETE FROM "AmazonAdsBrandMetric"`],
  ['AmazonAdsReportJob', `DELETE FROM "AmazonAdsReportJob"`],
  ['AmazonAdsExportJob', `DELETE FROM "AmazonAdsExportJob"`],
  ['AdvertisingActionLog', `DELETE FROM "AdvertisingActionLog"`],
  ['BudgetPoolAllocation', `DELETE FROM "BudgetPoolAllocation"`],
  ['BudgetPoolRebalance', `DELETE FROM "BudgetPoolRebalance"`],
  ['BudgetPool', `DELETE FROM "BudgetPool"`],
  ['CampaignBidHistory', `DELETE FROM "CampaignBidHistory"`],
  ['EbayMarkdown', `DELETE FROM "EbayMarkdown"`],
  ['EbayCampaign', `DELETE FROM "EbayCampaign"`],
  ['AdProductAd', `DELETE FROM "AdProductAd"`],
  ['AdTarget', `DELETE FROM "AdTarget"`],
  ['AdGroup', `DELETE FROM "AdGroup"`],
  ['Campaign', `DELETE FROM "Campaign"`],

  // ── A+ Content + Brand Story (children → parents)
  ['APlusContentAsin', `DELETE FROM "APlusContentAsin"`],
  ['APlusContentVersion', `DELETE FROM "APlusContentVersion"`],
  ['APlusModule', `DELETE FROM "APlusModule"`],
  ['APlusContent', `DELETE FROM "APlusContent"`],
  ['BrandStoryVersion', `DELETE FROM "BrandStoryVersion"`],
  ['BrandStoryModule', `DELETE FROM "BrandStoryModule"`],
  ['BrandStory', `DELETE FROM "BrandStory"`],

  // ── Fiscal + financial (FKs to Order, must precede Order delete)
  ['CreditNote', `DELETE FROM "CreditNote"`],
  ['CreditNoteCounter', `DELETE FROM "CreditNoteCounter"`],
  ['FiscalInvoice', `DELETE FROM "FiscalInvoice"`],
  ['FiscalInvoiceCounter', `DELETE FROM "FiscalInvoiceCounter"`],
  ['FxRate', `DELETE FROM "FxRate"`],
  ['FinancialTransaction', `DELETE FROM "FinancialTransaction"`],
  ['YearEndSnapshot', `DELETE FROM "YearEndSnapshot"`],

  // ── Inventory / stock (no Order FK; safe ordering)
  ['StockMovement', `DELETE FROM "StockMovement"`],
  ['StockReservation', `DELETE FROM "StockReservation"`],
  ['StockoutEvent', `DELETE FROM "StockoutEvent"`],
  ['StockCostLayer', `DELETE FROM "StockCostLayer"`],
  ['StockBinQuantity', `DELETE FROM "StockBinQuantity"`],
  ['ChannelStockEvent', `DELETE FROM "ChannelStockEvent"`],
  ['CycleCountItem', `DELETE FROM "CycleCountItem"`],
  ['CycleCount', `DELETE FROM "CycleCount"`],
  ['StockLog', `DELETE FROM "StockLog"`],
  ['StockLevel', `DELETE FROM "StockLevel"`],

  // ── Fulfillment (children → parents; FKs to Order)
  ['ShipmentItem', `DELETE FROM "ShipmentItem"`],
  ['Shipment', `DELETE FROM "Shipment"`],
  ['InboundShipmentAttachment', `DELETE FROM "InboundShipmentAttachment"`],
  ['InboundShipmentItem', `DELETE FROM "InboundShipmentItem"`],
  ['InboundReceipt', `DELETE FROM "InboundReceipt"`],
  ['InboundDiscrepancy', `DELETE FROM "InboundDiscrepancy"`],
  ['InboundShipment', `DELETE FROM "InboundShipment"`],
  ['FBAShipmentItem', `DELETE FROM "FBAShipmentItem"`],
  ['FBAShipment', `DELETE FROM "FBAShipment"`],
  ['MCFShipment', `DELETE FROM "MCFShipment"`],
  ['ReturnItem', `DELETE FROM "ReturnItem"`],
  ['Return', `DELETE FROM "Return"`],
  ['Refund', `DELETE FROM "Refund"`],
  ['RefundAttempt', `DELETE FROM "RefundAttempt"`],

  // ── Order-adjacent (FKs to Order)
  ['RoutingDecision', `DELETE FROM "RoutingDecision"`],
  ['OrderRiskScore', `DELETE FROM "OrderRiskScore"`],
  ['OrderTag', `DELETE FROM "OrderTag"`],
  ['OrderNote', `DELETE FROM "OrderNote"`],

  // ── Orders (the big one)
  ['OrderItem', `DELETE FROM "OrderItem"`],
  ['Order', `DELETE FROM "Order"`],

  // ── Customers (after Orders, since Order FKs to Customer)
  ['CustomerNote', `DELETE FROM "CustomerNote"`],
  ['CustomerAddress', `DELETE FROM "CustomerAddress"`],
  ['CustomerSegment', `DELETE FROM "CustomerSegment"`],
  ['Customer', `DELETE FROM "Customer"`],

  // ── Decision #6: eBay ChannelConnection abandoned-OAuth cleanup
  // Delete eBay connections that never completed OAuth (NULL tokens).
  // Preserves the 1 verified eBay connection + the Amazon env connection.
  ['ChannelConnection (eBay abandoned OAuth)', `
    DELETE FROM "ChannelConnection"
    WHERE "channelType" = 'EBAY'
      AND ("accessToken" IS NULL OR "refreshToken" IS NULL)
  `],

  // ── Decision #1: eBay stub ChannelListings (4 rows, NULL externalListingId)
  ['ChannelListing (eBay stubs)', `
    DELETE FROM "ChannelListing"
    WHERE channel = 'EBAY'
      AND "externalListingId" IS NULL
  `],
]

async function getCanary() {
  const r = await c.query(`
    SELECT
      (SELECT count(*) FROM "Product") AS products,
      (SELECT count(*) FROM "ChannelListing") AS channel_listings,
      (SELECT count(*) FROM "ChannelConnection") AS channel_connections,
      (SELECT count(*) FROM "ChannelConnection" WHERE "channelType" = 'AMAZON') AS amazon_connections,
      (SELECT count(*) FROM "ChannelConnection" WHERE "channelType" = 'EBAY') AS ebay_connections,
      (SELECT count(*) FROM "Marketplace") AS marketplaces,
      (SELECT count(*) FROM "BulkActionTemplate") AS bulk_action_templates,
      (SELECT count(*) FROM "WizardTemplate") AS wizard_templates,
      (SELECT count(*) FROM "ReturnPolicy") AS return_policies,
      (SELECT count(*) FROM "TerminologyPreference") AS terminology_prefs,
      (SELECT count(*) FROM "Warehouse") AS warehouses,
      (SELECT count(*) FROM "StockLocation") AS stock_locations,
      (SELECT count(*) FROM "ListingWizard") AS listing_wizards
  `)
  return r.rows[0]
}

// Capture pre-canary OUTSIDE transaction so we can compare even if rolled back
const preCanary = await getCanary()
log(`Pre-wipe canary: products=${preCanary.products} listings=${preCanary.channel_listings} connections=${preCanary.channel_connections} marketplaces=${preCanary.marketplaces}`)

await c.query('BEGIN')
log('TRANSACTION STARTED')

// Note: Neon's neondb_owner lacks superuser to SET session_replication_role,
// so we cannot disable triggers. The AuditLog immutability trigger therefore
// blocks DELETE — by design (L.6.0 migration). We preserve AuditLog (129 rows)
// as compliance history; everything else is deleted normally with FK checks on.

const deletedCounts = {}
let totalDeleted = 0n

try {
  for (const [label, sql] of wipePlan) {
    const r = await c.query(sql)
    const n = r.rowCount || 0
    deletedCounts[label] = n
    totalDeleted += BigInt(n)
    if (n > 0) log(`  DELETE ${label}: ${n} rows`)
  }

  // Post-canary inside transaction
  const postCanary = await getCanary()
  log(`Post-wipe canary: products=${postCanary.products} listings=${postCanary.channel_listings} connections=${postCanary.channel_connections} marketplaces=${postCanary.marketplaces}`)

  // ── Canary assertions ────────────────────────────────────────
  const failures = []
  if (Number(postCanary.products) !== Number(preCanary.products)) {
    failures.push(`Product count changed: ${preCanary.products} → ${postCanary.products}`)
  }
  if (Number(postCanary.marketplaces) !== Number(preCanary.marketplaces)) {
    failures.push(`Marketplace count changed: ${preCanary.marketplaces} → ${postCanary.marketplaces}`)
  }
  if (Number(postCanary.bulk_action_templates) !== Number(preCanary.bulk_action_templates)) {
    failures.push(`BulkActionTemplate count changed: ${preCanary.bulk_action_templates} → ${postCanary.bulk_action_templates}`)
  }
  if (Number(postCanary.wizard_templates) !== Number(preCanary.wizard_templates)) {
    failures.push(`WizardTemplate count changed: ${preCanary.wizard_templates} → ${postCanary.wizard_templates}`)
  }
  if (Number(postCanary.warehouses) !== Number(preCanary.warehouses)) {
    failures.push(`Warehouse count changed: ${preCanary.warehouses} → ${postCanary.warehouses}`)
  }
  // ChannelListing: preserved minus the 4 eBay stubs (Decision #1)
  const expectedListings = Number(preCanary.channel_listings) - (deletedCounts['ChannelListing (eBay stubs)'] || 0)
  if (Number(postCanary.channel_listings) !== expectedListings) {
    failures.push(`ChannelListing count mismatch: expected ${expectedListings}, got ${postCanary.channel_listings}`)
  }
  // ChannelConnection: preserved minus the eBay abandoned (Decision #6)
  const expectedConns = Number(preCanary.channel_connections) - (deletedCounts['ChannelConnection (eBay abandoned OAuth)'] || 0)
  if (Number(postCanary.channel_connections) !== expectedConns) {
    failures.push(`ChannelConnection count mismatch: expected ${expectedConns}, got ${postCanary.channel_connections}`)
  }
  // ListingWizard: PRESERVED (decision #5 implicit, the 6 drafts <30d stay)
  if (Number(postCanary.listing_wizards) !== Number(preCanary.listing_wizards)) {
    failures.push(`ListingWizard count changed: ${preCanary.listing_wizards} → ${postCanary.listing_wizards}`)
  }

  if (failures.length > 0) {
    log(`CANARY FAILED — ${failures.length} mismatches:`)
    failures.forEach(f => log(`   ✗ ${f}`))
    log('Rolling back.')
    await c.query('ROLLBACK')
  } else if (EXECUTE) {
    log(`CANARY PASSED. Committing.`)
    await c.query('COMMIT')
    log(`TRANSACTION COMMITTED — ${totalDeleted} rows deleted`)
  } else {
    log(`CANARY PASSED. (dry-run — rolling back)`)
    await c.query('ROLLBACK')
    log(`TRANSACTION ROLLED BACK — ${totalDeleted} rows would have been deleted`)
  }

  // ── Summary ─────────────────────────────────────────────────
  banner('Wipe summary (by delete count)')
  Object.entries(deletedCounts)
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)
    .forEach(([label, n]) => console.log(`  ${String(n).padStart(7)}  ${label}`))
  console.log(`  ${'='.repeat(7)}`)
  console.log(`  ${String(totalDeleted).padStart(7)}  TOTAL`)

  if (!EXECUTE) {
    console.log('\nRun with --execute to commit.')
  }
} catch (e) {
  log(`ERROR — ${e.message}`)
  log('Rolling back.')
  await c.query('ROLLBACK')
  process.exit(1)
} finally {
  await c.end()
}
