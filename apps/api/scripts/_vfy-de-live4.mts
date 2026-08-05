const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT p.sku, cl.region, cl."platformAttributes"->>'sharedSkuListing' AS shared,
          (cl."platformAttributes" ? '__offerIds') AS has_offer_ids
   FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
   WHERE cl.channel='EBAY' AND p.sku LIKE 'WATERPROOF-OVERJACKET-BLACK-MEN%'
   ORDER BY p.sku, cl.region`,
)
console.log('SHARED FLAGS:', JSON.stringify(r))
await prisma.$disconnect()
