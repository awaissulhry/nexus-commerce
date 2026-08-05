/* READ-ONLY probe 3 — grid filter (product-level) vs export filter (row-level). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const listings = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true, product: { select: { sku: true } } },
})
const mems = await prisma.sharedListingMembership.findMany({ where: { status: 'ACTIVE' }, select: { sku: true, productId: true } })
const rowSkus = [...listings.map((l) => l.product?.sku ?? '?'), ...mems.map((m) => m.sku)]

for (const needle of ['giubbotto', 'giacca', 'knee', 'ventilata']) {
  const rowHits = rowSkus.filter((s) => s.toLowerCase().includes(needle)).length
  const nameHits = await prisma.product.count({ where: { parentId: null, name: { contains: needle, mode: 'insensitive' } } })
  console.log(`q="${needle}"  masters matching by NAME (grid shows them): ${nameHits}   rows matching by SKU (export returns): ${rowHits}`)
}
await prisma.$disconnect()
