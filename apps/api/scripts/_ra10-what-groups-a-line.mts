/**
 * RA.GRAIN — if `AdProductAd.productId` is a VARIATION, what actually identifies a product LINE?
 *
 * Measured in _ra9: 250 advertised ASINs roll up to 223 distinct `Product` rows, each holding
 * exactly 1 ASIN, with the same line title repeated across a dozen rows. So binding a rule to
 * `productId` binds it to one size/colour, and covering "the GALE jacket" would take ~13 bindings.
 * The brief's definition of a product line does not survive the data. This finds the real one.
 *
 * Candidate groupings, in order of how much I'd trust them:
 *   a) ProductVariation rows        — the PIM's own parent→child model
 *   b) Product.amazonAsin           — the non-buyable PARENT asin, shared by a line's children
 *   c) Product.variationTheme       — set only on real parents
 *   d) SKU prefix                   — a convention, not a model; last resort
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = async <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

console.log('\n═══ the 223 advertised Product rows — what shape are they? ═══')
console.log(j((await q(`
  WITH adv AS (SELECT DISTINCT "productId" pid FROM "AdProductAd" WHERE "productId" IS NOT NULL)
  SELECT COUNT(*)::int advertised_products,
         COUNT(p."variationTheme")::int with_variation_theme,
         COUNT(p."amazonAsin")::int with_parent_asin,
         COUNT(DISTINCT p."amazonAsin")::int distinct_parent_asins,
         COUNT(DISTINCT p.name)::int distinct_names,
         (SELECT COUNT(*)::int FROM "ProductVariation" v WHERE v."productId" IN (SELECT pid FROM adv)) variation_rows_under_them
  FROM adv JOIN "Product" p ON p.id = adv.pid`))[0]))

console.log('\n═══ (a) does the PIM parent→child model cover them? ═══')
console.log(`ProductVariation rows in total: ${j((await q(`SELECT COUNT(*)::int n, COUNT(DISTINCT "productId")::int parents, COUNT("amazonAsin")::int with_asin FROM "ProductVariation"`))[0])}`)
console.log(`advertised ASINs that ARE a ProductVariation.amazonAsin: ${j((await q(`
  SELECT COUNT(DISTINCT pa.asin)::int n FROM "AdProductAd" pa
  WHERE pa.asin IN (SELECT "amazonAsin" FROM "ProductVariation" WHERE "amazonAsin" IS NOT NULL)`))[0])}`)

console.log('\n═══ (b) Product.amazonAsin — the shared parent ASIN ═══')
console.log(j(await q(`
  WITH adv AS (SELECT DISTINCT "productId" pid FROM "AdProductAd" WHERE "productId" IS NOT NULL)
  SELECT p."amazonAsin" parent_asin, COUNT(*)::int product_rows
  FROM adv JOIN "Product" p ON p.id = adv.pid
  GROUP BY p."amazonAsin" ORDER BY product_rows DESC LIMIT 10`)))

console.log('\n═══ (c/d) name and SKU shape — is the line encoded in either? ═══')
console.log('by exact name (top 8):')
console.log(j(await q(`
  WITH adv AS (SELECT DISTINCT "productId" pid FROM "AdProductAd" WHERE "productId" IS NOT NULL)
  SELECT LEFT(p.name, 28) name_prefix, COUNT(*)::int product_rows, COUNT(DISTINCT p."amazonAsin")::int parent_asins
  FROM adv JOIN "Product" p ON p.id = adv.pid
  GROUP BY p.name ORDER BY product_rows DESC LIMIT 8`)))
console.log('\nsample SKUs, to see whether a line is encoded in the SKU:')
console.log(j(await q(`
  WITH adv AS (SELECT DISTINCT "productId" pid FROM "AdProductAd" WHERE "productId" IS NOT NULL)
  SELECT p.sku, p."amazonAsin", p."variationTheme", LEFT(p.name, 22) nm
  FROM adv JOIN "Product" p ON p.id = adv.pid ORDER BY p.sku LIMIT 14`)))

console.log('\n═══ the line as the operator names it — first word after XAVIA ═══')
// Not a proposal for how to STORE it; a measurement of how many lines there actually are.
console.log(j(await q(`
  WITH adv AS (SELECT DISTINCT "productId" pid FROM "AdProductAd" WHERE "productId" IS NOT NULL),
  lines AS (
    SELECT SPLIT_PART(REGEXP_REPLACE(p.name, '^XAVIA\\s+', ''), ' ', 1) line, p.id
    FROM adv JOIN "Product" p ON p.id = adv.pid
  )
  SELECT l.line, COUNT(DISTINCT l.id)::int product_rows,
         COUNT(DISTINCT g."campaignId")::int campaigns,
         COUNT(DISTINCT pa.asin)::int asins
  FROM lines l
  JOIN "AdProductAd" pa ON pa."productId" = l.id
  JOIN "AdGroup" g ON g.id = pa."adGroupId"
  GROUP BY l.line ORDER BY campaigns DESC`)))

console.log('\n═══ and how many campaigns would each line reach? (the number the UI must state) ═══')
console.log('↑ the `campaigns` column above IS that number.')

console.log('\n═══ cross-check: is ProductFamily a red herring, as the brief says? ═══')
console.log(j((await q(`
  SELECT (SELECT COUNT(*)::int FROM "ProductFamily") families,
         (SELECT COUNT(*)::int FROM "Product" WHERE "familyId" IS NOT NULL) products_with_family`))[0]))

console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
