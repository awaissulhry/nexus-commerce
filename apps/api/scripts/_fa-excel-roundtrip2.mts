/** READ-ONLY probe 2 — NULL fulfillmentMethod exposure + lane overlap. */
const { default: prisma } = await import('../src/db.js')

const rows = await prisma.$queryRawUnsafe<any[]>(
  `SELECT cl.channel, cl.marketplace,
          count(*) FILTER (WHERE cl."fulfillmentMethod" IS NULL)::int AS fm_null,
          count(*) FILTER (WHERE cl."fulfillmentMethod" IS NULL AND coalesce(p."fulfillmentMethod"::text,'') <> 'FBA')::int AS fm_null_not_fba,
          count(*)::int AS total
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
    GROUP BY 1,2 ORDER BY 1,2`,
)
console.log('== published controllable listings, fulfillmentMethod NULL exposure ==')
console.table(rows)

const paused = await prisma.$queryRawUnsafe<any[]>(
  `SELECT count(*)::int AS n FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND cl."fulfillmentMethod" IS NULL AND coalesce(p."fulfillmentMethod"::text,'')<>'FBA' AND cl."syncPaused"=true`,
)
console.log('NULL-fm + currently syncPaused (a Follow import would silently fail):', paused)

const samples = await prisma.$queryRawUnsafe<any[]>(
  `SELECT p.sku, cl.channel, cl.marketplace, cl."externalListingId", cl.quantity, cl."followMasterQuantity", cl."syncPaused"
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND cl."fulfillmentMethod" IS NULL AND coalesce(p."fulfillmentMethod"::text,'')<>'FBA'
    ORDER BY p.sku LIMIT 8`,
)
console.log('== sample NULL-fm rows (export as normal editable rows) ==')
console.table(samples)

// lane overlap: is the LISTING row's externalListingId also a membership itemId?
const overlap = await prisma.$queryRawUnsafe<any[]>(
  `SELECT p.sku, cl."externalListingId" AS listing_item, cl.quantity AS listing_qty, cl."followMasterQuantity",
          (SELECT count(*)::int FROM "SharedListingMembership" m WHERE m.sku=p.sku AND m.status='ACTIVE') AS memberships,
          (SELECT count(*)::int FROM "SharedListingMembership" m WHERE m.sku=p.sku AND m.status='ACTIVE' AND m."itemId"=cl."externalListingId") AS same_item
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl.channel='EBAY' AND cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND p.sku IN ('GALE-JACKET-BLACK-MEN-XS','xavia-knee-slider-red','IT-MOSS-JACKET-BLACK-MEN-XL')`,
)
console.log('== eBay LISTING row vs its memberships ==')
console.table(overlap)

const totalOverlap = await prisma.$queryRawUnsafe<any[]>(
  `SELECT count(*)::int AS listing_rows_also_in_pool FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl.channel='EBAY' AND cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND EXISTS (SELECT 1 FROM "SharedListingMembership" m WHERE m.sku=p.sku AND m.status='ACTIVE')`,
)
console.log('eBay LISTING rows whose sku is ALSO pooled (both lanes exported):', totalOverlap)

await prisma.$disconnect()
