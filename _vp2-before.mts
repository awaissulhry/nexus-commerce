import { PrismaClient } from '@prisma/client'
const p = new PrismaClient({ datasources: { db: { url: process.argv[2] } } })
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const kid = await p.product.findFirst({ where: { parentId: GALE, sku: 'GALE-JACKET-BLACK-MEN-5XL' }, select: { id: true, sku: true } })
console.log('child:', JSON.stringify(kid))
const rows = await p.$queryRawUnsafe<any[]>(
  `SELECT id, channel, marketplace, "aliasKey", "listingStatus", "isPublished", "syncPaused", "variationExcluded", version, "externalListingId", "channelConnectionId"
     FROM "ChannelListing" WHERE "productId" = $1 ORDER BY channel, marketplace`, kid!.id)
for (const r of rows) console.log('  ', JSON.stringify(r))
const shopifyRows = await p.$queryRawUnsafe<any[]>(
  `SELECT count(*)::int AS n FROM "ChannelListing" WHERE "productId" = $1 AND channel='SHOPIFY'`, kid!.id)
console.log('shopify rows for this child:', shopifyRows[0].n)
await p.$disconnect()
