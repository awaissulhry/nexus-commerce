#!/usr/bin/env node
// Comprehensive /pricing audit (read-only).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }

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

await run('A. PricingSnapshot state', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "isClamped" = true) AS clamped,
         count(*) FILTER (WHERE source = 'FALLBACK') AS fallback,
         count(*) FILTER (WHERE source = 'SCHEDULED_SALE') AS sale,
         count(*) FILTER (WHERE source = 'OFFER_OVERRIDE') AS offer_override,
         count(*) FILTER (WHERE source = 'CHANNEL_OVERRIDE') AS channel_override,
         count(*) FILTER (WHERE source = 'CHANNEL_RULE') AS channel_rule,
         count(*) FILTER (WHERE source = 'PRICING_RULE') AS pricing_rule,
         count(*) FILTER (WHERE source = 'MASTER_INHERIT') AS master_inherit,
         count(*) FILTER (WHERE array_length(warnings,1) > 0) AS with_warnings
  FROM "PricingSnapshot"`)

await run('A2. Snapshot freshness', `
  SELECT MIN("computedAt") AS oldest, MAX("computedAt") AS newest,
         EXTRACT(EPOCH FROM (now() - MAX("computedAt")))/3600 AS newest_age_hours
  FROM "PricingSnapshot"`)

await run('B. Snapshots by channel/marketplace', `
  SELECT channel, marketplace, currency, count(*) AS rows,
         AVG("computedPrice")::numeric(10,2) AS avg_px,
         MIN("computedPrice")::numeric(10,2) AS min_px,
         MAX("computedPrice")::numeric(10,2) AS max_px
  FROM "PricingSnapshot"
  GROUP BY channel, marketplace, currency
  ORDER BY channel, marketplace`)

await run('C. Product master price state', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "basePrice" > 0) AS with_price,
         count(*) FILTER (WHERE "basePrice" = 0 OR "basePrice" IS NULL) AS no_price,
         count(*) FILTER (WHERE "salePrice" IS NOT NULL) AS on_sale,
         count(*) FILTER (WHERE "costPrice" IS NOT NULL) AS with_cost,
         count(*) FILTER (WHERE "minPrice" IS NOT NULL) AS with_floor,
         count(*) FILTER (WHERE "maxPrice" IS NOT NULL) AS with_ceiling,
         AVG("basePrice")::numeric(10,2) AS avg_base,
         AVG("costPrice")::numeric(10,2) AS avg_cost
  FROM "Product"
  WHERE "isParent" = false`)

await run('C2. Margin tier distribution', `
  SELECT count(*) FILTER (WHERE ("basePrice" - "costPrice") / NULLIF("basePrice", 0) > 0.5) AS high_50plus,
         count(*) FILTER (WHERE ("basePrice" - "costPrice") / NULLIF("basePrice", 0) > 0.3 AND ("basePrice" - "costPrice") / NULLIF("basePrice", 0) <= 0.5) AS mid_30_50,
         count(*) FILTER (WHERE ("basePrice" - "costPrice") / NULLIF("basePrice", 0) > 0.1 AND ("basePrice" - "costPrice") / NULLIF("basePrice", 0) <= 0.3) AS low_10_30,
         count(*) FILTER (WHERE ("basePrice" - "costPrice") / NULLIF("basePrice", 0) <= 0.1 AND "basePrice" > 0) AS thin_under_10,
         count(*) FILTER (WHERE "basePrice" < "costPrice") AS losing_money
  FROM "Product"
  WHERE "isParent" = false AND "basePrice" > 0 AND "costPrice" IS NOT NULL`)

await run('C3. ProductVariation pricing state', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE price > 0) AS with_price,
         count(*) FILTER (WHERE "costPrice" IS NOT NULL) AS with_cost,
         count(*) FILTER (WHERE "minPrice" IS NOT NULL) AS with_floor,
         count(*) FILTER (WHERE "maxPrice" IS NOT NULL) AS with_ceiling,
         count(*) FILTER (WHERE "mapPrice" IS NOT NULL) AS with_map
  FROM "ProductVariation"`)

await run('D. ChannelListing pricing by channel/marketplace', `
  SELECT channel, marketplace, count(*) AS listings,
         count(*) FILTER (WHERE "followMasterPrice" = true) AS follows_master,
         count(*) FILTER (WHERE "followMasterPrice" = false) AS independent,
         count(*) FILTER (WHERE "salePrice" IS NOT NULL) AS on_sale,
         count(*) FILTER (WHERE "lowestCompetitorPrice" IS NOT NULL) AS with_competitor,
         count(*) FILTER (WHERE "buyBoxPrice" IS NOT NULL) AS with_buybox,
         count(*) FILTER (WHERE "estimatedFbaFee" IS NOT NULL) AS with_fba_fee,
         count(*) FILTER (WHERE "referralFeePercent" IS NOT NULL) AS with_referral_pct,
         AVG(price)::numeric(10,2) AS avg_price
  FROM "ChannelListing"
  GROUP BY channel, marketplace
  ORDER BY count(*) DESC LIMIT 20`)

await run('E. Drift detection (master cascade gone wrong)', `
  SELECT count(*) AS total_drift,
         count(*) FILTER (WHERE cl."pricingRule" = 'FIXED') AS drift_fixed,
         count(*) FILTER (WHERE cl."pricingRule" = 'MATCH_AMAZON') AS drift_match_amazon,
         count(*) FILTER (WHERE cl."pricingRule" = 'PERCENT_OF_MASTER') AS drift_percent_of_master
  FROM "ChannelListing" cl
  JOIN "Product" p ON p.id = cl."productId"
  WHERE cl."followMasterPrice" = true
    AND cl.price IS NOT NULL
    AND ABS(cl.price - p."basePrice") > 0.01
    AND cl."pricingRule" IN ('FIXED','MATCH_AMAZON','PERCENT_OF_MASTER')`)

await run('F. ChannelListingOverride usage', `
  SELECT count(*) AS total, count(DISTINCT "channelListingId") AS distinct_listings,
         MIN("createdAt") AS oldest, MAX("createdAt") AS newest
  FROM "ChannelListingOverride"`)

await run('F2. Override field breakdown', `
  SELECT "fieldName", count(*) FROM "ChannelListingOverride"
  GROUP BY "fieldName" ORDER BY count(*) DESC LIMIT 15`)

await run('G. PricingRule usage', `
  SELECT count(*) AS total, count(*) FILTER (WHERE "isActive") AS active FROM "PricingRule"`)

await run('G2. Rule by type', `
  SELECT type, count(*) FROM "PricingRule" GROUP BY type`)

await run('H. PricingRuleProduct + PricingRuleVariation', `
  SELECT (SELECT count(*) FROM "PricingRuleProduct") AS rule_product_links,
         (SELECT count(*) FROM "PricingRuleVariation") AS rule_variation_links`)

await run('I. FxRate state', `
  SELECT count(*) AS total, MIN("asOf") AS oldest, MAX("asOf") AS newest,
         count(DISTINCT "toCurrency") AS distinct_currencies,
         EXTRACT(EPOCH FROM (now() - MAX("asOf")))/86400 AS newest_age_days
  FROM "FxRate"`)

await run('I2. Recent rates', `
  SELECT "fromCurrency", "toCurrency", rate, "asOf" FROM "FxRate"
  WHERE "asOf" > now() - INTERVAL '7 days'
  ORDER BY "asOf" DESC, "toCurrency" ASC LIMIT 20`)

await run('J. Marketplace VAT/currency table', `
  SELECT channel, code, currency, "vatRate", "taxInclusive"
  FROM "Marketplace" ORDER BY channel, code`)

await run('K. Coupon usage', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "endDate" > now()) AS active
  FROM "Coupon"`)

await run('L. RetailEvent', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "isActive") AS active,
         count(*) FILTER (WHERE "isActive" AND "startDate" <= now() AND "endDate" > now()) AS in_window
  FROM "RetailEvent"`)

await run('L2. RetailEventPriceAction', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "isActive") AS active
  FROM "RetailEventPriceAction"`)

await run('L3. RetailEvent by channel/marketplace', `
  SELECT channel, marketplace, count(*) FROM "RetailEvent"
  WHERE "isActive" = true
  GROUP BY channel, marketplace ORDER BY count(*) DESC LIMIT 10`)

await run('M. Pricing-related tables existence', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND (
    table_name ILIKE '%pric%' OR table_name ILIKE '%promo%' OR
    table_name ILIKE '%coupon%' OR table_name ILIKE '%discount%' OR
    table_name ILIKE '%competitor%' OR table_name ILIKE '%buybox%' OR
    table_name ILIKE '%markdown%' OR table_name ILIKE '%retail%' OR
    table_name ILIKE '%fxrate%' OR table_name ILIKE '%offer%' OR
    table_name ILIKE '%bestoffer%'
  )
  ORDER BY table_name`)

await run('N. ChannelListing pricing-related cols', `
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'ChannelListing'
    AND (column_name ILIKE '%price%' OR column_name ILIKE '%fee%'
         OR column_name ILIKE '%offer%' OR column_name ILIKE '%competitor%'
         OR column_name ILIKE '%buybox%' OR column_name ILIKE '%override%'
         OR column_name ILIKE '%map%' OR column_name ILIKE '%margin%'
         OR column_name ILIKE '%master%' OR column_name = 'priceOverride'
         OR column_name = 'lastOverrideAt' OR column_name = 'lastOverrideBy')
  ORDER BY ordinal_position`)

await run('O. Outbound queue pricing-related', `
  SELECT count(*) FILTER (WHERE "syncStatus" = 'PENDING' AND "syncType" = 'PRICE_UPDATE') AS pending_price_updates,
         count(*) FILTER (WHERE "syncStatus" = 'COMPLETED' AND "syncType" = 'PRICE_UPDATE' AND "createdAt" > now() - INTERVAL '7 days') AS completed_7d,
         count(*) FILTER (WHERE "syncStatus" = 'FAILED' AND "syncType" = 'PRICE_UPDATE' AND "createdAt" > now() - INTERVAL '7 days') AS failed_7d
  FROM "OutboundSyncQueue"`)

await run('P. Recent price changes via AuditLog (30d)', `
  SELECT count(*) AS price_changes_30d,
         count(*) FILTER (WHERE "userId" IS NOT NULL) AS user_initiated,
         count(*) FILTER (WHERE "userId" IS NULL) AS system_initiated
  FROM "AuditLog"
  WHERE "createdAt" > now() - INTERVAL '30 days'
    AND "entityType" = 'Product'
    AND metadata::jsonb ->> 'field' = 'basePrice'`)

await run('Q. Offer table (FBA/FBM offer pricing)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "fulfillmentMethod" = 'FBA') AS fba_offers,
         count(*) FILTER (WHERE "fulfillmentMethod" = 'FBM') AS fbm_offers,
         count(*) FILTER (WHERE price IS NOT NULL) AS with_price
  FROM "Offer"`)

await run('R. Multi-currency listing distribution', `
  SELECT m.currency, count(*) AS listings, AVG(cl.price)::numeric(10,2) AS avg_price
  FROM "ChannelListing" cl
  LEFT JOIN "Marketplace" m ON m.code = cl.marketplace AND m.channel = cl.channel
  WHERE cl.price IS NOT NULL
  GROUP BY m.currency ORDER BY count(*) DESC`)

await run('S. Above/below competitor positioning', `
  SELECT count(*) FILTER (WHERE price > "lowestCompetitorPrice") AS pricing_above,
         count(*) FILTER (WHERE price <= "lowestCompetitorPrice") AS pricing_at_or_below,
         AVG(price - "lowestCompetitorPrice")::numeric(10,2) AS avg_premium_eur
  FROM "ChannelListing"
  WHERE "lowestCompetitorPrice" IS NOT NULL AND price IS NOT NULL`)

await run('T. PricingSnapshot warning categories', `
  SELECT unnest(warnings) AS warning, count(*)
  FROM "PricingSnapshot" WHERE array_length(warnings,1) > 0
  GROUP BY warning ORDER BY count(*) DESC LIMIT 20`)

await run('U. Offer override count by channel/marketplace', `
  SELECT cl.channel, cl.marketplace, count(o.id) AS offer_overrides
  FROM "Offer" o JOIN "ChannelListing" cl ON cl.id = o."channelListingId"
  WHERE o.price IS NOT NULL
  GROUP BY cl.channel, cl.marketplace ORDER BY count(o.id) DESC LIMIT 10`)

await c.end()
console.log('\nAudit complete.')
