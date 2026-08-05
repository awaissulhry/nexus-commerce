// READ-ONLY: of the NULL-fm live Amazon listings, how many are NOT FBA by
// product fallback (i.e. controllable rows the import/apply updateMany misses)?
const prisma = (await import('../src/db.js')).default
const rows = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] }, fulfillmentMethod: null },
  select: { id: true, marketplace: true, syncPaused: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
const fbm = rows.filter((r) => r.product?.fulfillmentMethod !== 'FBA')
console.log(JSON.stringify({ nullFm: rows.length, fbmByFallback: fbm.length, sample: fbm.slice(0, 5).map((r) => `${r.product?.sku}@${r.marketplace}`) }))
await prisma.$disconnect(); process.exit(0)
