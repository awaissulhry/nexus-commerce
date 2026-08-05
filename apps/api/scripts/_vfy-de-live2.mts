const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT p.sku, cl.region, cl."listingStatus", cl."externalListingId", cl."offerActive",
          (cl."platformAttributes"->>'offerId') AS offer_id
   FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
   WHERE cl.channel='EBAY' AND cl.region='DE'
   ORDER BY p.sku`,
)
console.log(JSON.stringify(rows, null, 1))
await prisma.$disconnect()
