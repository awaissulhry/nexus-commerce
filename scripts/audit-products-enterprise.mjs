#!/usr/bin/env node
// Comprehensive enterprise /products audit (read-only).
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

await run('1. Product table state', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE "isParent" = true) AS parents,
         count(*) FILTER (WHERE "parentId" IS NOT NULL) AS children,
         count(*) FILTER (WHERE "isParent" = false AND "parentId" IS NULL) AS standalone,
         count(*) FILTER (WHERE status = 'ACTIVE') AS active,
         count(*) FILTER (WHERE status = 'DRAFT') AS draft,
         count(*) FILTER (WHERE status = 'INACTIVE') AS inactive,
         count(*) FILTER (WHERE status = 'ARCHIVED') AS archived,
         count(*) FILTER (WHERE "deletedAt" IS NOT NULL) AS soft_deleted,
         count(DISTINCT brand) AS unique_brands,
         count(DISTINCT "productType") AS unique_product_types
  FROM "Product"
`)

await run('2. Multi-channel coverage', `
  SELECT count(DISTINCT cl."productId") AS products_with_listings,
         count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'AMAZON') AS on_amazon,
         count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'EBAY') AS on_ebay,
         count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'SHOPIFY') AS on_shopify,
         count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'WOOCOMMERCE') AS on_woo,
         count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'ETSY') AS on_etsy,
         count(DISTINCT cl.marketplace) AS unique_marketplaces
  FROM "ChannelListing" cl
`)

await run('2b. ChannelListing breakdown by channel + status', `
  SELECT channel, "listingStatus" AS status, count(*) AS n
  FROM "ChannelListing"
  GROUP BY channel, "listingStatus"
  ORDER BY channel, "listingStatus"
`)

await run('3. Translations coverage by language', `
  SELECT language AS lang,
         count(*) AS rows,
         count(DISTINCT "productId") AS distinct_products,
         count(*) FILTER (WHERE "reviewedAt" IS NOT NULL) AS reviewed,
         count(*) FILTER (WHERE source LIKE 'ai-%') AS ai_sourced
  FROM "ProductTranslation"
  GROUP BY language
  ORDER BY rows DESC
`)

await run('3b. Translation totals', `
  SELECT count(*) AS total_translations,
         count(DISTINCT "productId") AS products_translated,
         count(DISTINCT language) AS unique_languages
  FROM "ProductTranslation"
`)

await run('4. Product relations', `
  SELECT type, count(*) AS n,
         count(DISTINCT "fromProductId") AS distinct_from
  FROM "ProductRelation"
  GROUP BY type
  ORDER BY type
`)

await run('4b. Relation totals', `
  SELECT count(*) AS total_relations,
         count(DISTINCT "fromProductId") AS products_with_relations
  FROM "ProductRelation"
`)

await run('5. Bundle table presence', `
  SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%bundle%' ORDER BY table_name
`)

await run('5b. Bundle counts (if exists)', `
  SELECT count(*) AS total_bundles,
         count(*) FILTER (WHERE "isActive" = true) AS active_bundles
  FROM "Bundle"
`)

await run('5c. BundleComponent counts (if exists)', `
  SELECT count(*) AS total_components,
         count(DISTINCT "bundleId") AS bundles_with_components,
         AVG(quantity)::numeric(10,2) AS avg_qty
  FROM "BundleComponent"
`)

await run('6. Custom attribute tables presence', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND (table_name ILIKE '%attribute%' OR table_name ILIKE '%family%' OR table_name ILIKE '%template%')
  ORDER BY table_name
`)

await run('7. SavedView for products surface', `
  SELECT count(*) AS total,
         count(DISTINCT "userId") AS users_with_views,
         count(*) FILTER (WHERE "isDefault" = true) AS defaults
  FROM "SavedView"
  WHERE surface = 'products'
`)

await run('7b. SavedView columns (schema check)', `
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'SavedView'
  ORDER BY ordinal_position
`)

await run('8. ProductImage stats', `
  SELECT count(*) AS total_images,
         count(DISTINCT "productId") AS products_with_images,
         count(*) FILTER (WHERE type = 'MAIN') AS main_images,
         count(*) FILTER (WHERE type = 'ALT') AS alt_images,
         count(*) FILTER (WHERE type = 'LIFESTYLE') AS lifestyle_images
  FROM "ProductImage"
`)

await run('8b. Avg images per product (with images)', `
  SELECT ROUND(AVG(n)::numeric, 2) AS avg_images_per_product, MAX(n) AS max_images
  FROM (SELECT "productId", count(*) AS n FROM "ProductImage" GROUP BY "productId") s
`)

await run('9. Tag link counts', `
  SELECT count(*) AS tag_links,
         count(DISTINCT "tagId") AS unique_tags_used,
         count(DISTINCT "productId") AS products_with_tags
  FROM "ProductTag"
`)

await run('9b. Tag table totals', `
  SELECT count(*) AS total_tags FROM "Tag"
`)

await run('10. Completeness analysis (10-factor)', `
  WITH completeness AS (
    SELECT
      p.id, p.sku,
      (CASE WHEN p.name IS NOT NULL AND p.name NOT ILIKE 'NEW-%' AND p.name != 'Untitled product' THEN 1 ELSE 0 END +
       CASE WHEN p."basePrice" > 0 THEN 1 ELSE 0 END +
       CASE WHEN p.brand IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN p."productType" IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN p.description IS NOT NULL AND length(p.description) > 100 THEN 1 ELSE 0 END +
       CASE WHEN p.gtin IS NOT NULL OR p.upc IS NOT NULL OR p.ean IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN p."weightValue" IS NOT NULL AND p."weightValue" > 0 THEN 1 ELSE 0 END +
       CASE WHEN p."dimLength" IS NOT NULL OR p."dimWidth" IS NOT NULL OR p."dimHeight" IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN EXISTS (SELECT 1 FROM "ProductImage" pi WHERE pi."productId" = p.id) THEN 1 ELSE 0 END +
       CASE WHEN EXISTS (SELECT 1 FROM "ProductTranslation" pt WHERE pt."productId" = p.id) THEN 1 ELSE 0 END
      )::float / 10 * 100 AS pct
    FROM "Product" p
    WHERE status IN ('ACTIVE', 'DRAFT') AND "deletedAt" IS NULL
  )
  SELECT
    count(*) AS total,
    AVG(pct)::int AS avg_pct,
    count(*) FILTER (WHERE pct = 100) AS fully_complete,
    count(*) FILTER (WHERE pct >= 75 AND pct < 100) AS mostly_complete,
    count(*) FILTER (WHERE pct >= 50 AND pct < 75) AS partial,
    count(*) FILTER (WHERE pct < 50) AS incomplete
  FROM completeness
`)

await run('11. Product schema columns', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'Product'
  ORDER BY ordinal_position
`)

await run('12. Enterprise tables existence check', `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'Product','ProductVariation','ProductTranslation','ProductImage','ProductRelation',
      'AttributeSet','AttributeGroup','CustomAttribute','AttributeValue','AttributeOption',
      'Bundle','BundleItem','BundleComponent','GroupedProduct','ConfigurableProduct',
      'ProductFamily','ProductTemplate','ProductWorkflow','WorkflowStage','WorkflowTransition',
      'TierPrice','CustomerGroupPrice','B2BCatalog','CustomerGroup',
      'Collection','Category','Taxonomy',
      'PriceList','PromotionRule','CrossSell','UpSell',
      'AssetLibrary','DigitalAsset','ReferenceEntity',
      'ScheduledProductChange','ChannelReadiness','RepricingRule',
      'ChannelOverride','PerChannelContent','BillOfMaterials',
      'Warehouse','SalesVelocity','SavedView','SavedViewAlert'
    )
  ORDER BY table_name
`)

await run('13. Drafts state', `
  SELECT count(*) AS total_draft,
         count(*) FILTER (WHERE name ILIKE 'NEW-%' OR name = 'Untitled product') AS empty_name,
         count(*) FILTER (WHERE "basePrice" = 0 OR "basePrice" IS NULL) AS no_price,
         count(*) FILTER (WHERE description IS NULL OR length(description) < 50) AS poor_desc
  FROM "Product" WHERE status = 'DRAFT'
`)

await run('14. ScheduledProductChange (if exists)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE status = 'PENDING') AS pending,
         count(*) FILTER (WHERE status = 'APPLIED') AS applied,
         count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
         count(DISTINCT "productId") AS products_scheduled
  FROM "ScheduledProductChange"
`)

await run('15. Top 10 brands by product count', `
  SELECT COALESCE(brand, '(no brand)') AS brand, count(*) AS n
  FROM "Product"
  WHERE "deletedAt" IS NULL
  GROUP BY brand
  ORDER BY n DESC
  LIMIT 10
`)

await run('16. Top 10 productTypes by count', `
  SELECT COALESCE("productType", '(no type)') AS type, count(*) AS n
  FROM "Product"
  WHERE "deletedAt" IS NULL
  GROUP BY "productType"
  ORDER BY n DESC
  LIMIT 10
`)

await run('17. AuditLog activity (last 30d) — Product entity', `
  SELECT action, count(*) AS n
  FROM "AuditLog"
  WHERE entity = 'Product' AND "createdAt" > NOW() - INTERVAL '30 days'
  GROUP BY action
  ORDER BY n DESC
`)

await run('18. OutboundSyncQueue (recent product-related)', `
  SELECT type, status, count(*) AS n
  FROM "OutboundSyncQueue"
  WHERE "createdAt" > NOW() - INTERVAL '7 days'
  GROUP BY type, status
  ORDER BY type, status
`)

await run('19. ProductVariation table check', `
  SELECT count(*) AS total_variations,
         count(DISTINCT "productId") AS parents_with_variations
  FROM "ProductVariation"
`)

await c.end()
console.log('\nDone.')
