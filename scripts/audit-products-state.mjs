#!/usr/bin/env node
// One-shot audit query runner for the /products foundation rebuild.
// Reads DATABASE_URL from packages/database/.env via Prisma; never
// prints the URL. Outputs sectioned results for the audit report.
//
// Run from the repo root:
//   node scripts/audit-products-state.mjs

import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Load DATABASE_URL from packages/database/.env without touching it
// elsewhere; the URL never leaves Prisma's process env.
const here = dirname(fileURLToPath(import.meta.url))
config({ path: join(here, '..', 'packages', 'database', '.env') })

const prisma = new PrismaClient()

const sections = []

async function section(name, label, q) {
  try {
    const rows = await prisma.$queryRawUnsafe(q)
    sections.push({ name, label, rows })
  } catch (err) {
    sections.push({
      name,
      label,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

await section(
  '3.2.A',
  'Product table state',
  `SELECT
     count(*)::int AS total,
     count(*) FILTER (WHERE "isParent" = true)::int AS parents,
     count(*) FILTER (WHERE "parentId" IS NOT NULL)::int AS children,
     count(*) FILTER (WHERE "isParent" = false AND "parentId" IS NULL)::int AS standalone,
     count(*) FILTER (WHERE "basePrice" = 0)::int AS zero_price,
     count(*) FILTER (WHERE name ILIKE 'NEW-%' OR name = 'Untitled product')::int AS draft_empty,
     count(*) FILTER (WHERE brand IS NULL)::int AS no_brand,
     count(*) FILTER (WHERE description IS NULL OR length(description) < 50)::int AS poor_description,
     count(*) FILTER (WHERE "amazonAsin" IS NOT NULL)::int AS has_asin,
     count(*) FILTER (WHERE gtin IS NOT NULL OR upc IS NOT NULL OR ean IS NOT NULL)::int AS has_identifier,
     count(DISTINCT brand)::int AS unique_brands,
     count(DISTINCT "productType")::int AS unique_product_types
   FROM "Product"`,
)

await section(
  '3.2.B',
  'Status breakdown + listing presence',
  `SELECT status, count(*)::int AS rows,
     count(*) FILTER (WHERE "isParent" = false AND id NOT IN (SELECT "productId" FROM "ChannelListing"))::int AS no_listings
   FROM "Product" GROUP BY status ORDER BY count(*) DESC`,
)

await section(
  '3.2.C',
  'Multi-channel coverage',
  `SELECT
     count(DISTINCT p.id)::int AS products_total,
     count(DISTINCT cl."productId")::int AS products_with_listings,
     count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'AMAZON')::int AS on_amazon,
     count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'EBAY')::int AS on_ebay,
     count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'SHOPIFY')::int AS on_shopify,
     count(DISTINCT cl."productId") FILTER (WHERE cl.channel = 'WOOCOMMERCE')::int AS on_woo,
     count(DISTINCT cl.marketplace)::int AS unique_marketplaces
   FROM "Product" p
   LEFT JOIN "ChannelListing" cl ON cl."productId" = p.id
   WHERE p."isParent" = false`,
)

await section(
  '3.2.D',
  'Per-(channel, marketplace) listing health',
  `SELECT channel, marketplace, count(*)::int AS listings,
     count(*) FILTER (WHERE "listingStatus" = 'LIVE')::int AS live,
     count(*) FILTER (WHERE "listingStatus" = 'DRAFT')::int AS draft,
     count(*) FILTER (WHERE "listingStatus" = 'ERROR' OR "lastSyncStatus" = 'FAILED')::int AS error
   FROM "ChannelListing" GROUP BY channel, marketplace ORDER BY channel, marketplace`,
)

await section(
  '3.2.E',
  'Variant mechanism (parentId vs ProductVariation)',
  `SELECT 'Product.parentId' AS mechanism, count(*)::int AS rows FROM "Product" WHERE "parentId" IS NOT NULL
   UNION ALL
   SELECT 'ProductVariation', count(*)::int FROM "ProductVariation"`,
)

await section(
  '3.2.F',
  'Outbound sync backlog',
  `SELECT "syncStatus" AS status, count(*)::int AS rows,
     min("createdAt") AS oldest,
     max("createdAt") FILTER (WHERE "syncStatus" = 'PENDING') AS newest_pending
   FROM "OutboundSyncQueue" GROUP BY "syncStatus" ORDER BY status`,
)

await section(
  '3.2.G',
  'Drift: ChannelListing.price vs Product.basePrice',
  `SELECT count(*)::int AS rows_with_drift,
     count(*) FILTER (WHERE cl."followMasterPrice" = true)::int AS following_master_total
   FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
   WHERE cl."followMasterPrice" = true AND cl.price != p."basePrice"`,
)

await section(
  '3.2.H',
  'Drift: ChannelListing.quantity vs computed expected',
  `SELECT count(*)::int AS rows_with_drift,
     count(*) FILTER (WHERE cl."followMasterQuantity" = true)::int AS following_master_total
   FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
   WHERE cl."followMasterQuantity" = true
     AND cl.quantity != GREATEST(0, p."totalStock" - COALESCE(cl."stockBuffer", 0))`,
)

await section(
  '3.2.I',
  'Orphan Product rows (created by abandoned wizards)',
  `SELECT count(*)::int AS orphan_drafts
   FROM "Product" p
   WHERE p.status = 'DRAFT'
     AND p."createdAt" < NOW() - INTERVAL '7 days'
     AND NOT EXISTS (SELECT 1 FROM "ChannelListing" cl WHERE cl."productId" = p.id)
     AND NOT EXISTS (SELECT 1 FROM "ListingWizard" lw WHERE lw."productId" = p.id)`,
)

await section(
  '3.2.J',
  'Recent activity (last 30 days)',
  `SELECT date_trunc('day', "updatedAt")::date AS day, count(*)::int AS updates
   FROM "Product" WHERE "updatedAt" > NOW() - INTERVAL '30 days'
   GROUP BY day ORDER BY day DESC LIMIT 14`,
)

await section(
  '3.2.K',
  'Tag + saved-view + alert usage',
  `SELECT
     (SELECT count(*) FROM "ProductTag")::int AS total_tag_links,
     (SELECT count(DISTINCT "tagId") FROM "ProductTag")::int AS unique_tags,
     (SELECT count(*) FROM "SavedView" WHERE surface = 'products')::int AS saved_views,
     (SELECT count(*) FROM "SavedViewAlert")::int AS saved_view_alerts`,
)

await section(
  '3.2.L',
  'Product schema columns (count + null-allowed)',
  `SELECT count(*)::int AS column_count,
     count(*) FILTER (WHERE is_nullable = 'YES')::int AS nullable_columns
   FROM information_schema.columns WHERE table_name = 'Product'`,
)

await prisma.$disconnect()

// Pretty print. Each section is delimited so the user can read it.
const fmt = (v) => {
  if (v === null || v === undefined) return '—'
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return v.toString()
  return v
}
for (const s of sections) {
  console.log('\n━━━ ' + s.name + ' — ' + s.label + ' ━━━')
  if (s.error) {
    console.log('  ERROR: ' + s.error)
    continue
  }
  if (!s.rows || s.rows.length === 0) {
    console.log('  (no rows)')
    continue
  }
  // Tabular output
  const cols = Object.keys(s.rows[0])
  const widths = cols.map((c) =>
    Math.max(c.length, ...s.rows.map((r) => String(fmt(r[c])).length)),
  )
  console.log(
    '  ' + cols.map((c, i) => c.padEnd(widths[i])).join('  '),
  )
  console.log(
    '  ' + cols.map((_c, i) => '─'.repeat(widths[i])).join('  '),
  )
  for (const r of s.rows) {
    console.log(
      '  ' +
        cols.map((c, i) => String(fmt(r[c])).padEnd(widths[i])).join('  '),
    )
  }
}
