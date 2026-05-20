#!/usr/bin/env node
// Phase 0 + Phase 1 read-only audit for the 2026-05-20 data wipe + backfill.
// Captures canary baselines (Phase 0), wipe manifest (Phase 0b), and
// listing-graph tagging (Phase 1) in a single DB session. Writes a markdown
// report to docs/data-wipe-2026-05-20/audit-report.md.
//
// SAFE: read-only. No DELETE / UPDATE / INSERT. Run with:
//   node scripts/data-wipe-2026-05-20-audit.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()

const out = []
function md(s) { out.push(s) }

// run a query; returns rows array (empty on error). Logs error inline.
async function q(label, sql, params = []) {
  try {
    const r = await c.query(sql, params)
    return r.rows
  } catch (e) {
    md(`> ⚠ **${label}** query failed: \`${e.message}\``)
    return []
  }
}

// helper — render rows as a markdown table
function table(rows) {
  if (!rows || rows.length === 0) return '_(no rows)_\n'
  const cols = Object.keys(rows[0])
  const head = `| ${cols.join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const body = rows.map(r => `| ${cols.map(k => {
    const v = r[k]
    if (v === null || v === undefined) return '_null_'
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
    return String(v).replace(/\|/g, '\\|').slice(0, 100)
  }).join(' | ')} |`).join('\n')
  return `${head}\n${sep}\n${body}\n`
}

// ── Header ─────────────────────────────────────────────────────────
md(`# Data Wipe Audit — 2026-05-20`)
md(``)
md(`**Generated:** ${new Date().toISOString()}`)
md(`**Database:** ${url.replace(/:[^:@/]+@/, ':***@').slice(0, 80)}...`)
md(`**Purpose:** Phase 0 + Phase 1 read-only audit. No data modified.`)
md(``)
md(`---`)
md(``)

// ── Phase 0a: Canary baseline (preserve these) ─────────────────────
md(`## Phase 0a — Canary baseline (PRESERVE)`)
md(``)
md(`These counts are what must survive the wipe. Verify post-wipe matches.`)
md(``)

md(`### Products (master catalog)`)
md(table(await q('product totals', `
  SELECT
    count(*) AS total_products,
    count(*) FILTER (WHERE "importSource" IS NULL) AS real_null_source,
    count(*) FILTER (WHERE "importSource" = 'MANUAL') AS real_manual,
    count(*) FILTER (WHERE "importSource" = 'XAVIA_REALISTIC_TEST') AS fake_xavia_test,
    count(*) FILTER (WHERE "importSource" = 'PERFORMANCE_TEST') AS fake_perf_test,
    count(*) FILTER (WHERE status = 'ACTIVE') AS active,
    count(*) FILTER (WHERE status = 'DRAFT') AS draft,
    count(*) FILTER (WHERE status = 'INACTIVE') AS inactive
  FROM "Product"
`)))

md(`### Product importSource distribution (full breakdown)`)
md(table(await q('importSource breakdown', `
  SELECT COALESCE("importSource", '_NULL_') AS source, count(*) AS rows
  FROM "Product" GROUP BY "importSource" ORDER BY count(*) DESC
`)))

md(`### Product variations`)
md(table(await q('variation totals', `
  SELECT
    count(*) AS total_variations,
    count(DISTINCT "productId") AS products_with_variations
  FROM "ProductVariation"
`)))

md(`### Product images (master gallery)`)
md(table(await q('product images', `
  SELECT count(*) AS total_images, count(DISTINCT "productId") AS products_with_images
  FROM "ProductImage"
`)))

md(`### ChannelListing (per-channel listings)`)
md(table(await q('channel listings', `
  SELECT channel, marketplace, count(*) AS listings,
         count(*) FILTER (WHERE "listingStatus" = 'ACTIVE') AS active,
         count(*) FILTER (WHERE "listingStatus" = 'INACTIVE') AS inactive
  FROM "ChannelListing"
  GROUP BY channel, marketplace
  ORDER BY count(*) DESC
`)))

md(`### VariantChannelListing (per-variant per-channel)`)
md(table(await q('variant channel listings', `
  SELECT count(*) AS total,
         count(DISTINCT "variantId") AS distinct_variants,
         count(DISTINCT channel) AS distinct_channels
  FROM "VariantChannelListing"
`)))

md(`### ChannelConnection (auth — PRESERVE always)`)
md(table(await q('channel connections', `
  SELECT "channelType", marketplace, "managedBy",
         "displayName",
         ("accessToken" IS NOT NULL) AS has_access_token,
         ("refreshToken" IS NOT NULL) AS has_refresh_token
  FROM "ChannelConnection"
  ORDER BY "channelType", marketplace
`)))

md(`### DigitalAsset (DAM) summary`)
md(table(await q('digital assets', `
  SELECT count(*) AS total_assets,
         count(*) FILTER (WHERE type = 'image') AS images,
         count(*) FILTER (WHERE type = 'video') AS videos,
         (SUM("sizeBytes")/1024.0/1024.0)::numeric(10,2) AS total_mb
  FROM "DigitalAsset"
`)))

md(`### Product → channel-identity coverage`)
md(table(await q('product channel id coverage', `
  SELECT count(*) AS products,
         count("amazonAsin") AS with_amazon_asin,
         count("ebayItemId") AS with_ebay_item_id,
         count("shopifyProductId") AS with_shopify_id,
         count("upc") AS with_upc,
         count("ean") AS with_ean,
         count("costPrice") AS with_cost_price,
         count("brand") AS with_brand
  FROM "Product"
`)))

md(`### ChannelListing → external-id coverage`)
md(table(await q('channel listing external id coverage', `
  SELECT channel, marketplace,
         count(*) AS listings,
         count("externalListingId") AS with_external_id,
         count("platformProductId") AS with_platform_product_id,
         count("title") AS with_title
  FROM "ChannelListing"
  GROUP BY channel, marketplace
  ORDER BY channel, marketplace
`)))

md(`### Marketplace (config — PRESERVE)`)
md(table(await q('marketplace config', `
  SELECT count(*) AS marketplaces FROM "Marketplace"
`)))

md(`### Operational templates (PRESERVE)`)
md(table(await q('operational templates', `
  SELECT
    (SELECT count(*) FROM "BulkActionTemplate") AS bulk_action_templates,
    (SELECT count(*) FROM "WizardTemplate") AS wizard_templates,
    (SELECT count(*) FROM "ReturnPolicy") AS return_policies,
    (SELECT count(*) FROM "RetailEvent") AS retail_events,
    (SELECT count(*) FROM "TerminologyPreference") AS terminology_prefs,
    (SELECT count(*) FROM "Warehouse") AS warehouses
`)))

md(``)
md(`---`)
md(``)

// ── Phase 0b: Wipe manifest ────────────────────────────────────────
md(`## Phase 0b — Wipe manifest (DELETE candidates)`)
md(``)
md(`Each subsection shows row counts and date range for tables that Phase 2 will delete.`)
md(``)

md(`### Orders + line items`)
md(table(await q('orders', `
  SELECT
    count(*) AS total_orders,
    count(*) FILTER (WHERE channel = 'AMAZON') AS amazon,
    count(*) FILTER (WHERE channel = 'EBAY') AS ebay,
    count(*) FILTER (WHERE channel = 'SHOPIFY') AS shopify,
    count(*) FILTER (WHERE channel NOT IN ('AMAZON','EBAY','SHOPIFY')) AS other,
    min("createdAt")::date AS earliest,
    max("createdAt")::date AS latest,
    SUM("totalPrice")::numeric(14,2) AS gross_revenue
  FROM "Order"
`)))
md(table(await q('order items', `SELECT count(*) AS total_order_items FROM "OrderItem"`)))
md(table(await q('order notes', `SELECT count(*) AS total_order_notes FROM "OrderNote"`)))
md(table(await q('order tags', `SELECT count(*) AS total_order_tags FROM "OrderTag"`)))
md(table(await q('order risk scores', `SELECT count(*) AS total_order_risk_scores FROM "OrderRiskScore"`)))
md(table(await q('routing decisions', `SELECT count(*) AS total_routing_decisions FROM "RoutingDecision"`)))

md(`### Customers`)
md(table(await q('customers', `
  SELECT count(*) AS total_customers,
         count(*) FILTER (WHERE "lastOrderAt" IS NOT NULL) AS with_orders,
         count(*) FILTER (WHERE "fiscalKind" = 'B2B') AS b2b,
         count(*) FILTER (WHERE "fiscalKind" = 'B2C') AS b2c
  FROM "Customer"
`)))
md(table(await q('customer addresses', `SELECT count(*) AS total_customer_addresses FROM "CustomerAddress"`)))
md(table(await q('customer notes', `SELECT count(*) AS total_customer_notes FROM "CustomerNote"`)))
md(table(await q('customer segments', `SELECT count(*) AS total_customer_segments FROM "CustomerSegment"`)))

md(`### Shipments + fulfillment`)
md(table(await q('shipments', `SELECT count(*) AS total_shipments FROM "Shipment"`)))
md(table(await q('shipment items', `SELECT count(*) AS total_shipment_items FROM "ShipmentItem"`)))
md(table(await q('inbound shipments', `SELECT count(*) AS total_inbound_shipments FROM "InboundShipment"`)))
md(table(await q('inbound shipment items', `SELECT count(*) AS total_inbound_shipment_items FROM "InboundShipmentItem"`)))
md(table(await q('inbound receipts', `SELECT count(*) AS total_inbound_receipts FROM "InboundReceipt"`)))
md(table(await q('outbound sync queue', `SELECT count(*) AS total_outbound_sync_queue FROM "OutboundSyncQueue"`)))
md(table(await q('outbound api call log', `SELECT count(*) AS total_outbound_api_call_log FROM "OutboundApiCallLog"`)))
md(table(await q('fba shipments', `SELECT count(*) AS total_fba_shipments FROM "FBAShipment"`)))
md(table(await q('mcf shipments', `SELECT count(*) AS total_mcf_shipments FROM "MCFShipment"`)))

md(`### Returns + refunds`)
md(table(await q('returns', `
  SELECT count(*) AS total_returns,
         min("createdAt")::date AS earliest,
         max("createdAt")::date AS latest
  FROM "Return"
`)))
md(table(await q('return items', `SELECT count(*) AS total_return_items FROM "ReturnItem"`)))
md(table(await q('refunds', `SELECT count(*) AS total_refunds FROM "Refund"`)))
md(table(await q('refund attempts', `SELECT count(*) AS total_refund_attempts FROM "RefundAttempt"`)))

md(`### Inventory + stock`)
md(table(await q('stock movements', `
  SELECT count(*) AS total_stock_movements,
         min("createdAt")::date AS earliest,
         max("createdAt")::date AS latest
  FROM "StockMovement"
`)))
md(table(await q('stock levels', `SELECT count(*) AS total_stock_levels FROM "StockLevel"`)))
md(table(await q('stock log', `SELECT count(*) AS total_stock_log FROM "StockLog"`)))
md(table(await q('stock reservations', `SELECT count(*) AS total_stock_reservations FROM "StockReservation"`)))
md(table(await q('stockout events', `SELECT count(*) AS total_stockout_events FROM "StockoutEvent"`)))
md(table(await q('stock cost layers', `SELECT count(*) AS total_stock_cost_layers FROM "StockCostLayer"`)))
md(table(await q('cycle counts', `SELECT count(*) AS total_cycle_counts FROM "CycleCount"`)))
md(table(await q('cycle count items', `SELECT count(*) AS total_cycle_count_items FROM "CycleCountItem"`)))
md(table(await q('stock bin quantities', `SELECT count(*) AS total_stock_bin_quantities FROM "StockBinQuantity"`)))
md(table(await q('channel stock events', `SELECT count(*) AS total_channel_stock_events FROM "ChannelStockEvent"`)))

md(`### Inventory PRESERVED (real physical / lot data — do NOT delete in Phase 2)`)
md(table(await q('lots', `SELECT count(*) AS total_lots FROM "Lot"`)))
md(table(await q('lot recalls', `SELECT count(*) AS total_lot_recalls FROM "LotRecall"`)))
md(table(await q('serial numbers', `SELECT count(*) AS total_serial_numbers FROM "SerialNumber"`)))
md(table(await q('bundles', `SELECT count(*) AS total_bundles FROM "Bundle"`)))
md(table(await q('stock bins', `SELECT count(*) AS total_stock_bins FROM "StockBin"`)))
md(table(await q('stock locations', `SELECT count(*) AS total_stock_locations FROM "StockLocation"`)))

md(`### Fiscal + financial`)
md(table(await q('fiscal invoices', `
  SELECT count(*) AS total_fiscal_invoices,
         count(*) FILTER (WHERE "sdiStatus" = 'SENT') AS sdi_sent,
         count(*) FILTER (WHERE "sdiStatus" = 'ACCEPTED') AS sdi_accepted
  FROM "FiscalInvoice"
`)))
md(table(await q('credit notes', `SELECT count(*) AS total_credit_notes FROM "CreditNote"`)))
md(table(await q('financial transactions', `
  SELECT count(*) AS total_financial_transactions,
         min("createdAt")::date AS earliest,
         max("createdAt")::date AS latest
  FROM "FinancialTransaction"
`)))
md(table(await q('fx rates', `SELECT count(*) AS total_fx_rates FROM "FxRate"`)))
md(table(await q('year-end snapshots', `SELECT count(*) AS total_year_end_snapshots FROM "YearEndSnapshot"`)))

md(`### Advertising (Amazon Ads + eBay Promoted)`)
md(table(await q('campaigns', `
  SELECT count(*) AS total_campaigns,
         count(*) FILTER (WHERE "externalCampaignId" IS NOT NULL) AS with_external_id,
         count(*) FILTER (WHERE "externalCampaignId" IS NULL) AS local_only,
         count(*) FILTER (WHERE status = 'ENABLED') AS enabled
  FROM "Campaign"
`)))
md(table(await q('ad groups', `SELECT count(*) AS total_ad_groups FROM "AdGroup"`)))
md(table(await q('ad targets', `SELECT count(*) AS total_ad_targets FROM "AdTarget"`)))
md(table(await q('ad product ads', `SELECT count(*) AS total_ad_product_ads FROM "AdProductAd"`)))
md(table(await q('amazon ads daily performance', `SELECT count(*) AS total_daily_perf FROM "AmazonAdsDailyPerformance"`)))
md(table(await q('amazon ads search terms', `SELECT count(*) AS total_search_terms FROM "AmazonAdsSearchTerm"`)))
md(table(await q('amazon ads placement reports', `SELECT count(*) AS total_placement_reports FROM "AmazonAdsPlacementReport"`)))
md(table(await q('amazon ads brand metrics', `SELECT count(*) AS total_brand_metrics FROM "AmazonAdsBrandMetric"`)))
md(table(await q('amazon ads report jobs', `SELECT count(*) AS total_ads_report_jobs FROM "AmazonAdsReportJob"`)))
md(table(await q('amazon ads export jobs', `SELECT count(*) AS total_ads_export_jobs FROM "AmazonAdsExportJob"`)))
md(table(await q('advertising action log', `SELECT count(*) AS total_advertising_action_log FROM "AdvertisingActionLog"`)))
md(table(await q('budget pools', `SELECT count(*) AS total_budget_pools FROM "BudgetPool"`)))
md(table(await q('budget pool allocations', `SELECT count(*) AS total_budget_pool_allocations FROM "BudgetPoolAllocation"`)))
md(table(await q('budget pool rebalances', `SELECT count(*) AS total_budget_pool_rebalances FROM "BudgetPoolRebalance"`)))
md(table(await q('campaign bid history', `SELECT count(*) AS total_campaign_bid_history FROM "CampaignBidHistory"`)))
md(table(await q('ebay campaigns', `SELECT count(*) AS total_ebay_campaigns FROM "EbayCampaign"`)))
md(table(await q('ebay markdowns', `SELECT count(*) AS total_ebay_markdowns FROM "EbayMarkdown"`)))
md(table(await q('amazon ads connections', `
  SELECT count(*) AS total_connections,
         count(*) FILTER (WHERE "isActive" = true) AS active,
         count(*) FILTER (WHERE mode = 'sandbox') AS sandbox,
         count(*) FILTER (WHERE mode = 'production') AS production
  FROM "AmazonAdsConnection"
`)))

md(`### Analytics aggregates`)
md(table(await q('daily sales aggregate', `SELECT count(*) AS total_daily_sales_aggregate FROM "DailySalesAggregate"`)))
md(table(await q('product profit daily', `SELECT count(*) AS total_product_profit_daily FROM "ProductProfitDaily"`)))
md(table(await q('fba storage age', `SELECT count(*) AS total_fba_storage_age FROM "FbaStorageAge"`)))
md(table(await q('listing quality snapshots', `SELECT count(*) AS total_listing_quality_snapshots FROM "ListingQualitySnapshot"`)))
md(table(await q('listing reconciliation', `SELECT count(*) AS total_listing_reconciliation FROM "ListingReconciliation"`)))
md(table(await q('forecast accuracy', `SELECT count(*) AS total_forecast_accuracy FROM "ForecastAccuracy"`)))

md(`### Wizard / draft artifacts`)
md(table(await q('listing wizards', `
  SELECT count(*) AS total_wizards,
         count(*) FILTER (WHERE status = 'DRAFT') AS drafts,
         count(*) FILTER (WHERE status = 'SUBMITTED') AS submitted,
         count(*) FILTER (WHERE status = 'LIVE') AS live,
         count(*) FILTER (WHERE status = 'FAILED') AS failed
  FROM "ListingWizard"
`)))
md(table(await q('wizard step events', `SELECT count(*) AS total_wizard_step_events FROM "WizardStepEvent"`)))
md(table(await q('scheduled wizard publishes', `
  SELECT count(*) AS total_scheduled_wizard_publishes,
         count(*) FILTER (WHERE "scheduledFor" > NOW()) AS future
  FROM "ScheduledWizardPublish"
`)))
md(table(await q('draft listings', `SELECT count(*) AS total_draft_listings FROM "DraftListing"`)))

md(`### Logs + telemetry`)
md(table(await q('audit log', `SELECT count(*) AS total_audit_log FROM "AuditLog"`)))
md(table(await q('sync log', `SELECT count(*) AS total_sync_log FROM "SyncLog"`)))
md(table(await q('sync log error groups', `SELECT count(*) AS total_sync_log_error_groups FROM "SyncLogErrorGroup"`)))
md(table(await q('sync errors', `SELECT count(*) AS total_sync_errors FROM "SyncError"`)))
md(table(await q('sync health log', `SELECT count(*) AS total_sync_health_log FROM "SyncHealthLog"`)))
md(table(await q('ai usage log', `SELECT count(*) AS total_ai_usage_log FROM "AiUsageLog"`)))
md(table(await q('alert events', `SELECT count(*) AS total_alert_events FROM "AlertEvent"`)))
md(table(await q('cron runs', `SELECT count(*) AS total_cron_runs FROM "CronRun"`)))
md(table(await q('rate limit log', `SELECT count(*) AS total_rate_limit_log FROM "RateLimitLog"`)))
md(table(await q('tracking events', `SELECT count(*) AS total_tracking_events FROM "TrackingEvent"`)))
md(table(await q('tracking message log', `SELECT count(*) AS total_tracking_message_log FROM "TrackingMessageLog"`)))
md(table(await q('webhook events', `SELECT count(*) AS total_webhook_events FROM "WebhookEvent"`)))
md(table(await q('login events', `SELECT count(*) AS total_login_events FROM "LoginEvent"`)))
md(table(await q('flat file pull jobs', `SELECT count(*) AS total_flat_file_pull_jobs FROM "FlatFilePullJob"`)))
md(table(await q('flat file pull records', `SELECT count(*) AS total_flat_file_pull_records FROM "FlatFilePullRecord"`)))
md(table(await q('import jobs', `SELECT count(*) AS total_import_jobs FROM "ImportJob"`)))
md(table(await q('export jobs', `SELECT count(*) AS total_export_jobs FROM "ExportJob"`)))
md(table(await q('repricing decisions', `SELECT count(*) AS total_repricing_decisions FROM "RepricingDecision"`)))

md(``)
md(`---`)
md(``)

// ── Phase 1: Listing-graph tagging ─────────────────────────────────
md(`## Phase 1 — Listing-graph fence tagging`)
md(``)
md(`Identifies which rows in ambiguous tables are linked to the live 279-SKU catalog vs orphaned test data.`)
md(``)

md(`### DigitalAsset orphan analysis`)
md(table(await q('digital asset summary', `
  WITH a AS (
    SELECT id,
           CASE WHEN EXISTS (
             SELECT 1 FROM "AssetUsage" u WHERE u."assetId" = "DigitalAsset".id AND u."productId" IS NOT NULL
           ) THEN 'LINKED_TO_PRODUCT' ELSE 'ORPHAN' END AS linkage,
           "sizeBytes",
           type
    FROM "DigitalAsset"
  )
  SELECT linkage, type,
         count(*) AS rows,
         SUM("sizeBytes")::bigint AS total_bytes,
         (SUM("sizeBytes")/1024.0/1024.0)::numeric(10,2) AS total_mb
  FROM a
  GROUP BY linkage, type
  ORDER BY linkage, total_bytes DESC NULLS LAST
`)))

md(`### AssetUsage breakdown`)
md(table(await q('asset usage breakdown', `
  SELECT scope, role, count(*) AS usages,
         count(*) FILTER (WHERE "productId" IS NOT NULL) AS with_product_fk,
         count(*) FILTER (WHERE "productId" IS NULL) AS no_product_fk
  FROM "AssetUsage"
  GROUP BY scope, role
  ORDER BY usages DESC
`)))

md(`### AssetUsage rows pointing to non-existent Products (truly orphaned)`)
md(table(await q('asset usage dangling', `
  SELECT count(*) AS dangling_usages
  FROM "AssetUsage" u
  WHERE u."productId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = u."productId")
`)))

md(`### Campaign / AdGroup / AdTarget orphan tagging`)
md(table(await q('campaign linkage', `
  WITH c AS (
    SELECT camp.id,
           CASE WHEN EXISTS (
             SELECT 1
             FROM "AdGroup" g
             JOIN "AdProductAd" a ON a."adGroupId" = g.id
             WHERE g."campaignId" = camp.id
               AND a."productId" IS NOT NULL
               AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id = a."productId")
           ) THEN 'LIVE_PRODUCT_LINKED' ELSE 'ORPHAN_OR_UNLINKED' END AS linkage,
           camp."externalCampaignId" IS NOT NULL AS has_external_id
    FROM "Campaign" camp
  )
  SELECT linkage, has_external_id, count(*) AS rows
  FROM c GROUP BY linkage, has_external_id ORDER BY rows DESC
`)))

md(`### AdProductAd → Product linkage`)
md(table(await q('ad product ad linkage', `
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE "productId" IS NOT NULL) AS with_product_fk,
    count(*) FILTER (WHERE "productId" IS NULL) AS no_product_fk,
    count(*) FILTER (
      WHERE "productId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = "AdProductAd"."productId")
    ) AS dangling_product_fk
  FROM "AdProductAd"
`)))

md(`### APlusContent / APlusContentAsin linkage`)
md(table(await q('aplus content linkage', `
  SELECT count(*) AS total_aplus,
         count(*) FILTER (WHERE status = 'PUBLISHED') AS published,
         count(*) FILTER (WHERE status = 'DRAFT') AS draft,
         count(*) FILTER (WHERE status = 'APPROVED') AS approved
  FROM "APlusContent"
`)))
md(table(await q('aplus asin attachments', `
  SELECT
    count(*) AS total_attachments,
    count(*) FILTER (WHERE "productId" IS NOT NULL) AS with_product_fk,
    count(*) FILTER (WHERE "productId" IS NULL) AS standalone_asin,
    count(*) FILTER (
      WHERE "productId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = "APlusContentAsin"."productId")
    ) AS dangling_product_fk
  FROM "APlusContentAsin"
`)))

md(`### BrandStory inventory`)
md(table(await q('brand story', `
  SELECT count(*) AS total_brand_stories,
         count(DISTINCT brand) AS distinct_brands,
         count(DISTINCT marketplace) AS distinct_marketplaces
  FROM "BrandStory"
`)))

md(`### ListingWizard expiry tagging`)
md(table(await q('wizard expiry tagging', `
  SELECT
    CASE
      WHEN status != 'DRAFT' THEN 'KEEP_non_draft'
      WHEN "createdAt" > NOW() - INTERVAL '30 days' THEN 'KEEP_recent_draft'
      ELSE 'EXPIRED_old_draft'
    END AS tag,
    count(*) AS rows
  FROM "ListingWizard"
  GROUP BY 1 ORDER BY 2 DESC
`)))

md(`### Brand assets (PRESERVE — these are brand-level, not per-product)`)
md(table(await q('brand assets', `
  SELECT
    (SELECT count(*) FROM "BrandKit") AS brand_kits,
    (SELECT count(*) FROM "BrandSettings") AS brand_settings,
    (SELECT count(*) FROM "BrandVoice") AS brand_voices,
    (SELECT count(*) FROM "BrandWatermarkTemplate") AS brand_watermark_templates
`)))

md(``)
md(`---`)
md(``)

// ── Backfill readiness: what's currently flowing? ──────────────────
md(`## Phase 0c — Live channel signal check`)
md(``)
md(`Are the production crons actually writing data? Quick health check.`)
md(``)

md(`### Sync health log (last 7 days, by channel + errorType)`)
md(table(await q('recent sync activity', `
  SELECT channel, "errorType", severity, count(*) AS rows,
         max("createdAt")::timestamp AS last_event
  FROM "SyncHealthLog"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY channel, "errorType", severity
  ORDER BY count(*) DESC
  LIMIT 30
`)))

md(`### Cron runs (last 7 days)`)
md(table(await q('recent cron runs', `
  SELECT "jobName", status, count(*) AS runs,
         max("startedAt")::timestamp AS last_run
  FROM "CronRun"
  WHERE "startedAt" > NOW() - INTERVAL '7 days'
  GROUP BY "jobName", status
  ORDER BY max("startedAt") DESC
  LIMIT 50
`)))

md(`### OutboundApiCallLog — recent activity (sample of channels hit)`)
md(table(await q('outbound api activity', `
  SELECT channel, "method", count(*) AS calls,
         max("createdAt")::timestamp AS last_call
  FROM "OutboundApiCallLog"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY channel, method
  ORDER BY count(*) DESC
  LIMIT 20
`)))

md(`### Recent order ingestion (last 14 days, by channel)`)
md(table(await q('order ingestion last 14d', `
  SELECT channel, marketplace,
         date_trunc('day', "createdAt")::date AS day,
         count(*) AS orders
  FROM "Order"
  WHERE "createdAt" > NOW() - INTERVAL '14 days'
  GROUP BY channel, marketplace, date_trunc('day', "createdAt")
  ORDER BY day DESC, count(*) DESC
  LIMIT 50
`)))

md(``)
md(`---`)
md(``)

// ── Recommended actions ────────────────────────────────────────────
md(`## Recommended next actions`)
md(``)
md(`1. **Take Neon branch snapshot** before any destructive action: \`neon branches create --name pre-wipe-2026-05-20\` (or via Neon Console).`)
md(`2. **Review this manifest** — look for unexpected high counts in PRESERVE section.`)
md(`3. **Decide on edge cases**:`)
md(`   - APlusContentAsin standalone (productId IS NULL) — keep or wipe?`)
md(`   - Campaigns with no Product link but with externalCampaignId — live in Amazon, just not mapped locally; keep or wipe?`)
md(`   - DigitalAssets that are orphans but with operator labels (likely brand/lifestyle photos) — wipe or migrate to BrandKit?`)
md(`4. **Approve Phase 2 destructive migration** with eyes open on row counts.`)
md(``)
md(`Generated by \`scripts/data-wipe-2026-05-20-audit.mjs\`. Re-run any time (read-only).`)

await c.end()

// Write to disk
const outPath = path.join(here, '..', 'docs', 'data-wipe-2026-05-20', 'audit-report.md')
fs.writeFileSync(outPath, out.join('\n'))
console.log(`\nWrote ${out.length} lines to ${outPath}`)
console.log(`Done.`)
