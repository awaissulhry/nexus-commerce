/**
 * VT.1 Phase 0 — read-only measurement on ONE named database.
 *   npx tsx scripts/_vt1-phase0-db.mts <DATABASE_URL>
 * The URL is passed EXPLICITLY (reference_which_database_is_this_api_on); every statement is a SELECT.
 * Answers: the discriminator, the `xracing` family (T18), GALE's eBay coordinate + category, the `''` theme row (T16),
 * and the derivation per family × Amazon marketplace using the SAME functions VT.0 used.
 */
const url = process.argv[2]
if (!url) { console.error('usage: tsx _vt1-phase0-db.mts <DATABASE_URL>'); process.exit(2) }
const direct = url.replace('-pooler', '')
console.log('DB host:', direct.split('@')[1]?.split('/')[0], '| db:', direct.split('/').pop()?.split('?')[0])
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url: direct } } })
const q = <T = Record<string, unknown>>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

console.log('role:', j(await q(`SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`)))
console.log('POSITIVE CONTROL Product rows:', Number((await q<{ n: bigint }>(`SELECT count(*)::bigint n FROM "Product"`))[0]!.n))
console.log('DISCRIMINATOR:', j(await q(`SELECT sku, version, "productType", "variationAxes", "variationTheme" FROM "Product" WHERE sku='GALE-JACKET'`)))

console.log('\n=== T18 · xracing family')
const xr = await q<{ id: string; sku: string; variationTheme: string | null; variationAxes: string[]; children: bigint }>(
  `SELECT r.id, r.sku, r."variationTheme", r."variationAxes", (SELECT count(*) FROM "Product" c WHERE c."parentId"=r.id)::bigint children
   FROM "Product" r WHERE r."variationTheme" ILIKE '%Fit Type%' AND r."parentId" IS NULL`)
console.log('roots with a Fit Type theme:', j(xr))
for (const r of xr) {
  console.log(`  children variantAttributes (first 6 of ${Number(r.children)}):`)
  console.log('  ', j(await q(`SELECT sku, "variantAttributes", "variationTheme", "variationAxes", "categoryAttributes"->'variations' AS cat_variations
     FROM "Product" WHERE "parentId"=$1 ORDER BY sku LIMIT 6`, r.id)))
  console.log('  distinct variantAttributes KEY SETS across all children:')
  console.log('  ', j(await q(`SELECT keys, count(*)::bigint n FROM (
      SELECT (SELECT string_agg(k,',' ORDER BY k) FROM jsonb_object_keys(COALESCE("variantAttributes",'{}'::jsonb)) k) keys
      FROM "Product" WHERE "parentId"=$1) t GROUP BY 1 ORDER BY 2 DESC`, r.id)))
  console.log('  Amazon/eBay listings on the family:')
  console.log('  ', j(await q(`SELECT cl.channel, cl."marketplace", count(*)::bigint n,
      count(cl."variationTheme")::bigint with_theme, count(cl."variationMapping")::bigint with_mapping,
      string_agg(DISTINCT cl."listingStatus", ',') statuses
    FROM "ChannelListing" cl JOIN "Product" c ON c.id=cl."productId"
    WHERE c.id=$1 OR c."parentId"=$1 GROUP BY 1,2 ORDER BY 1,2`, r.id)))
}

console.log('\n=== T16 · every ChannelListing row carrying a non-null variationTheme')
console.log(j(await q(`SELECT cl.channel, cl."marketplace", pr.sku, pr."parentId" IS NULL is_root, cl."variationTheme",
   length(cl."variationTheme") len, cl."variationMapping", cl."listingStatus", cl."externalListingId", cl."aliasId"
   FROM "ChannelListing" cl JOIN "Product" pr ON pr.id=cl."productId"
   WHERE cl."variationTheme" IS NOT NULL OR cl."variationMapping" IS NOT NULL ORDER BY cl.channel, pr.sku`)))

console.log('\n=== GALE family coordinates (channel × marketplace × alias), parent rows only')
const gale = (await q<{ id: string }>(`SELECT id FROM "Product" WHERE sku='GALE-JACKET'`))[0]!
console.log(j(await q(`SELECT cl.channel, cl."marketplace", cl."aliasId", cl."listingStatus", cl."externalListingId", cl."externalParentId",
    cl."platformAttributes"->'ebayCategoryId' ebay_cat, cl."version"
  FROM "ChannelListing" cl WHERE cl."productId"=$1 ORDER BY cl.channel, cl."marketplace"`, gale.id)))
console.log('eBay platformAttributes keys + any category value on the family:')
console.log(j(await q(`SELECT pr.sku, cl."marketplace", (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(COALESCE(cl."platformAttributes",'{}'::jsonb)) k) pa_keys,
    cl."platformAttributes"->>'categoryId' cat_id, cl."platformAttributes"->>'ebayCategoryId' ebay_cat_id
  FROM "ChannelListing" cl JOIN "Product" pr ON pr.id=cl."productId" WHERE (pr.id=$1 OR pr."parentId"=$1) AND cl.channel='EBAY' ORDER BY pr.sku LIMIT 4`, gale.id)))
console.log('Product columns mentioning category/ebay:')
console.log(j(await q(`SELECT column_name FROM information_schema.columns WHERE table_name='Product' AND (column_name ILIKE '%categor%' OR column_name ILIKE '%ebay%') ORDER BY 1`)))
console.log('Product row category fields:', j(await q(`SELECT sku, "productType", "categoryAttributes"->'ebay' ebay_cat_attrs FROM "Product" WHERE id=$1`, gale.id)))
await p.$disconnect()
