/** READ-ONLY probe 4 — LISTING-lane itemId loss vs family scoping. */
const { default: prisma } = await import('../src/db.js')

const both = await prisma.$queryRawUnsafe<any[]>(
  `SELECT count(*)::int AS listing_rows_whose_itemid_is_also_a_pool_family
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl.channel='EBAY' AND cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND EXISTS (SELECT 1 FROM "SharedListingMembership" m
                   WHERE m.status='ACTIVE' AND m.sku=p.sku AND m."itemId"=cl."externalListingId")`,
)
console.log(both)

const perItem = await prisma.$queryRawUnsafe<any[]>(
  `SELECT cl."externalListingId" AS item_id, count(*)::int AS listing_lane_rows_hidden_from_that_family
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl.channel='EBAY' AND cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
      AND EXISTS (SELECT 1 FROM "SharedListingMembership" m
                   WHERE m.status='ACTIVE' AND m.sku=p.sku AND m."itemId"=cl."externalListingId")
    GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
)
console.table(perItem)

// GALE detail: rows the workbook shows for one sku @ EBAY:IT
const gale = await prisma.$queryRawUnsafe<any[]>(
  `SELECT 'LISTING' AS lane, p.sku, cl."externalListingId" AS item_id, cl.quantity AS qty, cl."followMasterQuantity"::text AS follow
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE p.sku='GALE-JACKET-BLACK-MEN-XS' AND cl.channel='EBAY' AND cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
   UNION ALL
   SELECT 'SHARED', m.sku, m."itemId", m."lastQtyPushed", m."followPool"::text
     FROM "SharedListingMembership" m WHERE m.sku='GALE-JACKET-BLACK-MEN-XS' AND m.status='ACTIVE'
   ORDER BY 1,3`,
)
console.log('== what the workbook contains for GALE-JACKET-BLACK-MEN-XS @ EBAY:IT ==')
console.table(gale)

await prisma.$disconnect()
