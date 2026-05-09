#!/usr/bin/env node
// Comprehensive /products/drafts audit (read-only).
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

await run('1. Product DRAFT status counts', `
  SELECT count(*) AS total_draft,
         count(*) FILTER (WHERE name ILIKE 'NEW-%' OR name = 'Untitled product') AS empty_name,
         count(*) FILTER (WHERE "basePrice" = 0 OR "basePrice" IS NULL) AS no_price,
         count(*) FILTER (WHERE description IS NULL OR length(description) < 50) AS poor_desc,
         count(*) FILTER (WHERE "isParent" = true) AS parents,
         count(*) FILTER (WHERE "parentId" IS NOT NULL) AS children,
         MIN("createdAt")::date AS oldest,
         MAX("updatedAt")::date AS most_recent
  FROM "Product"
  WHERE status = 'DRAFT'
`)

await run('2. ListingWizard status', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE status = 'DRAFT') AS draft,
         count(*) FILTER (WHERE status = 'SUBMITTED') AS submitted,
         count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
         count(*) FILTER (WHERE "expiresAt" < NOW()) AS expired_now,
         count(*) FILTER (WHERE "expiresAt" IS NULL) AS expires_null,
         ROUND(AVG("currentStep")::numeric, 2) AS avg_step,
         MAX("currentStep") AS max_step,
         MIN("currentStep") AS min_step
  FROM "ListingWizard"
`)

await run('3. Wizard step distribution (DRAFT only)', `
  SELECT "currentStep" AS step, count(*) AS wizards
  FROM "ListingWizard"
  WHERE status = 'DRAFT'
  GROUP BY "currentStep"
  ORDER BY "currentStep"
`)

await run('4. Stale drafts (Product)', `
  SELECT
    count(*) FILTER (WHERE "updatedAt" < NOW() - INTERVAL '30 days') AS stale_30d,
    count(*) FILTER (WHERE "updatedAt" < NOW() - INTERVAL '60 days') AS stale_60d,
    count(*) FILTER (WHERE "updatedAt" < NOW() - INTERVAL '90 days') AS stale_90d
  FROM "Product"
  WHERE status = 'DRAFT'
`)

await run('5. Stale wizards', `
  SELECT
    count(*) FILTER (WHERE "updatedAt" < NOW() - INTERVAL '7 days') AS stale_7d,
    count(*) FILTER (WHERE "updatedAt" < NOW() - INTERVAL '30 days') AS stale_30d,
    count(*) FILTER (WHERE "updatedAt" < NOW() - INTERVAL '90 days') AS stale_90d,
    count(*) FILTER (WHERE "expiresAt" < NOW()) AS expired_now,
    count(*) FILTER (WHERE "expiresAt" < NOW() + INTERVAL '7 days' AND "expiresAt" >= NOW()) AS expiring_7d
  FROM "ListingWizard"
  WHERE status = 'DRAFT'
`)

await run('6. Wizard <-> Product link health', `
  SELECT
    count(*) AS total_wizards,
    count(*) FILTER (WHERE p.id IS NOT NULL) AS valid_link,
    count(*) FILTER (WHERE p.id IS NULL) AS orphan_wizard,
    count(*) FILTER (WHERE p.status = 'ACTIVE') AS product_active,
    count(*) FILTER (WHERE p.status = 'DRAFT') AS product_draft,
    count(*) FILTER (WHERE p.status = 'ARCHIVED') AS product_archived
  FROM "ListingWizard" lw
  LEFT JOIN "Product" p ON p.id = lw."productId"
`)

await run('7. DraftListing table check', `
  SELECT count(*) AS exists_count FROM information_schema.tables WHERE table_name = 'DraftListing'
`)

await run('7b. DraftListing counts (if exists)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE channel = 'AMAZON') AS amazon,
         count(*) FILTER (WHERE channel = 'EBAY') AS ebay,
         count(*) FILTER (WHERE channel = 'SHOPIFY') AS shopify,
         count(DISTINCT "productId") AS distinct_products
  FROM "DraftListing"
`)

await run('8. Status enum (Product)', `
  SELECT DISTINCT status, count(*) AS n
  FROM "Product"
  GROUP BY status
  ORDER BY status
`)

await run('9. ListingWizard status text', `
  SELECT DISTINCT status, count(*) AS n
  FROM "ListingWizard"
  GROUP BY status
  ORDER BY status
`)

await run('9b. DraftListing schema', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'DraftListing'
  ORDER BY ordinal_position
`)

await run('9c. DraftListing actual counts', `
  SELECT count(*) AS total FROM "DraftListing"
`)

await run('10. Wizard age vs progress (DRAFT)', `
  SELECT
    "currentStep" AS step,
    count(*) AS n,
    ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - "createdAt"))/86400)::numeric, 1) AS avg_age_days,
    ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - "updatedAt"))/86400)::numeric, 1) AS avg_idle_days
  FROM "ListingWizard"
  WHERE status = 'DRAFT'
  GROUP BY "currentStep"
  ORDER BY "currentStep"
`)

await run('14. Orphan wizards (productId points nowhere)', `
  SELECT lw.id AS wizard_id, lw."productId", lw."currentStep", lw."updatedAt"::date AS last_update
  FROM "ListingWizard" lw
  LEFT JOIN "Product" p ON p.id = lw."productId"
  WHERE p.id IS NULL
  ORDER BY lw."updatedAt" DESC
  LIMIT 10
`)

await run('15. Sample healthy wizards', `
  SELECT lw.id AS wizard_id, p.sku, p.name, lw."currentStep", lw.status, lw."updatedAt"::date
  FROM "ListingWizard" lw
  JOIN "Product" p ON p.id = lw."productId"
  ORDER BY lw."updatedAt" DESC
  LIMIT 10
`)

await run('16. Wizard cron / cleanup audit (recent)', `
  SELECT
    count(*) FILTER (WHERE "createdAt" > NOW() - INTERVAL '7 days') AS created_7d,
    count(*) FILTER (WHERE "updatedAt" > NOW() - INTERVAL '7 days') AS touched_7d,
    count(*) FILTER (WHERE "completedAt" IS NOT NULL) AS completed_ever
  FROM "ListingWizard"
`)

await run('11. Wizard schema columns', `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'ListingWizard'
  ORDER BY ordinal_position
`)

await run('12. Completeness distribution (Product DRAFT)', `
  WITH completeness AS (
    SELECT
      p.id,
      (CASE WHEN p.name IS NOT NULL AND p.name NOT ILIKE 'NEW-%' AND p.name != 'Untitled product' THEN 1 ELSE 0 END +
       CASE WHEN p."basePrice" > 0 THEN 1 ELSE 0 END +
       CASE WHEN p.brand IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN p."productType" IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN p.description IS NOT NULL AND length(p.description) > 50 THEN 1 ELSE 0 END +
       CASE WHEN p.gtin IS NOT NULL OR p.upc IS NOT NULL OR p.ean IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN EXISTS (SELECT 1 FROM "ProductImage" pi WHERE pi."productId" = p.id) THEN 1 ELSE 0 END
      )::float / 7 * 100 AS pct
    FROM "Product" p
    WHERE status = 'DRAFT'
  )
  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE pct < 25) AS very_incomplete,
    count(*) FILTER (WHERE pct >= 25 AND pct < 50) AS partial,
    count(*) FILTER (WHERE pct >= 50 AND pct < 75) AS mostly,
    count(*) FILTER (WHERE pct >= 75 AND pct < 100) AS nearly,
    count(*) FILTER (WHERE pct = 100) AS complete_but_draft
  FROM completeness
`)

await run('13. ChannelListing presence on draft products', `
  SELECT
    count(DISTINCT p.id) AS draft_products,
    count(DISTINCT p.id) FILTER (WHERE EXISTS (SELECT 1 FROM "ChannelListing" cl WHERE cl."productId" = p.id)) AS with_listings,
    count(DISTINCT p.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "ChannelListing" cl WHERE cl."productId" = p.id)) AS without_listings
  FROM "Product" p
  WHERE p.status = 'DRAFT'
`)

await c.end()
console.log('\nDone.')
