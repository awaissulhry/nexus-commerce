/** READ-ONLY: sanity-check SCV.1 enrichment (image/family/pool) for a few products. */
const { default: prisma } = await import('../src/db.js')
const { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } = await import('../src/services/product-read-cache.service.js')

const sample = await prisma.channelListing.findMany({
  where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
  select: { productId: true }, distinct: ['productId'], take: 6,
})
const ids = sample.map((s) => s.productId)
const meta = await prisma.product.findMany({
  where: { id: { in: ids } },
  select: {
    id: true, sku: true, name: true,
    family: { select: { code: true, label: true } },
    images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY },
    parent: { select: { images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY } } },
  },
})
for (const m of meta) {
  const img = pickFaceImage(m.images ?? []) ?? pickFaceImage(m.parent?.images ?? []) ?? null
  const pool = await prisma.stockLevel.aggregate({
    where: { productId: m.id, location: { type: 'WAREHOUSE' } }, _sum: { available: true },
  })
  console.log(`${m.sku}\n  name=${m.name?.slice(0,40)} family=${m.family?.code ?? '-'} pool=${pool._sum.available ?? 0} img=${img ? img.slice(0,55) : 'NONE'}`)
}
await prisma.$disconnect()
