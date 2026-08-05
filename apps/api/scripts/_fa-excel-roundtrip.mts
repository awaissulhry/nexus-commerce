/** READ-ONLY probe — DIM5 Excel round-trip audit. */
const { default: prisma } = await import('../src/db.js')

const marketsCL = await prisma.$queryRawUnsafe<any[]>(
  `SELECT channel, marketplace, count(*)::int AS n FROM "ChannelListing"
   WHERE "isPublished" = true AND "listingStatus" NOT IN ('ENDED','REMOVED')
   GROUP BY 1,2 ORDER BY 1,2`,
)
console.log('== ChannelListing published channel/marketplace ==')
console.table(marketsCL)

const marketsM = await prisma.$queryRawUnsafe<any[]>(
  `SELECT marketplace, count(*)::int AS n FROM "SharedListingMembership" WHERE status='ACTIVE' GROUP BY 1 ORDER BY 1`,
)
console.log('== SharedListingMembership ACTIVE marketplace ==')
console.table(marketsM)

const dupCL = await prisma.$queryRawUnsafe<any[]>(
  `SELECT cl."productId", p.sku, cl.channel, cl.marketplace, count(*)::int AS n,
          string_agg(coalesce(cl."externalListingId",'(null)'), ' | ') AS itemids,
          string_agg(coalesce(cl."fulfillmentMethod"::text,'NULL'), ',') AS fm,
          string_agg(cl.quantity::text, ',') AS qtys
     FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
    WHERE cl."isPublished" = true AND cl."listingStatus" NOT IN ('ENDED','REMOVED')
    GROUP BY 1,2,3,4 HAVING count(*) > 1
    ORDER BY n DESC LIMIT 25`,
)
console.log('== DUP published ChannelListing per (productId,channel,marketplace):', dupCL.length)
console.table(dupCL)

const dupTotal = await prisma.$queryRawUnsafe<any[]>(
  `SELECT count(*)::int AS groups, sum(n)::int AS rows FROM (
     SELECT count(*)::int AS n FROM "ChannelListing"
      WHERE "isPublished" = true AND "listingStatus" NOT IN ('ENDED','REMOVED')
      GROUP BY "productId", channel, marketplace HAVING count(*) > 1) t`,
)
console.log('dup group totals', dupTotal)

const memMulti = await prisma.$queryRawUnsafe<any[]>(
  `SELECT sku, marketplace, count(DISTINCT "itemId")::int AS items, string_agg(DISTINCT "itemId", ',') AS itemids
     FROM "SharedListingMembership" WHERE status='ACTIVE'
    GROUP BY 1,2 HAVING count(DISTINCT "itemId") > 1 ORDER BY items DESC LIMIT 10`,
)
console.log('== SHARED sku+market with multiple itemIds ==', memMulti.length)
console.table(memMulti)

const memDupKey = await prisma.$queryRawUnsafe<any[]>(
  `SELECT sku, marketplace, "itemId", count(*)::int AS n FROM "SharedListingMembership"
    WHERE status='ACTIVE' GROUP BY 1,2,3 HAVING count(*)>1 ORDER BY n DESC LIMIT 10`,
)
console.log('== SHARED duplicate exact key (sku,market,itemId) ==', memDupKey.length)
console.table(memDupKey)

const nullPid = await prisma.sharedListingMembership.count({ where: { status: 'ACTIVE', productId: null } })
const totMem = await prisma.sharedListingMembership.count({ where: { status: 'ACTIVE' } })
console.log('ACTIVE memberships with NULL productId:', nullPid, '/', totMem)

// Prisma `not: 'FBA'` NULL semantics on a nullable column
const notFba = await prisma.channelListing.count({ where: { fulfillmentMethod: { not: 'FBA' } } })
const isNull = await prisma.channelListing.count({ where: { fulfillmentMethod: null } })
const isFba = await prisma.channelListing.count({ where: { fulfillmentMethod: 'FBA' } })
const all = await prisma.channelListing.count()
console.log({ all, isFba, isNull, notFba, nullsIncludedInNot: notFba === all - isFba })

// LISTING lane rows that share sku+channel+market with a SHARED row (fallback lane confusion)
const cross = await prisma.$queryRawUnsafe<any[]>(
  `SELECT p.sku, cl.channel, cl.marketplace, m."itemId"
     FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
     JOIN "SharedListingMembership" m ON m.sku = p.sku AND m.marketplace = cl.marketplace AND m.status='ACTIVE'
    WHERE cl."isPublished"=true AND cl."listingStatus" NOT IN ('ENDED','REMOVED') AND cl.channel='EBAY'
    LIMIT 10`,
)
console.log('== same sku+market present in BOTH lanes (eBay) ==', cross.length)
console.table(cross)

await prisma.$disconnect()
