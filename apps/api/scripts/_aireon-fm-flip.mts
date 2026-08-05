/** Complete the owner's FBA→FBM conversion at VARIANT level for AIREON.
 *  Predicate is fail-safe: only variants under the AIREON master whose
 *  product.fm='FBA' AND zero FBA stock AND no active FBA offer AND listing-
 *  level signals already clear — i.e. the single stale latch. */
const { default: prisma } = await import('../src/db.js')
const master = await prisma.product.findFirst({ where: { sku: 'AIREON', parentId: null }, select: { id: true } })
if (!master) throw new Error('AIREON master not found')
const kids = await prisma.product.findMany({
  where: { parentId: master.id, deletedAt: null, fulfillmentMethod: 'FBA' },
  select: { id: true, sku: true },
})
console.log(`variants still product.fm=FBA: ${kids.length}`)
const safe: string[] = []
for (const k of kids) {
  const fba = await prisma.stockLevel.aggregate({ where: { productId: k.id, location: { code: 'AMAZON-EU-FBA' } }, _sum: { quantity: true } })
  const offer = await prisma.offer.findFirst({ where: { channelListing: { productId: k.id }, fulfillmentMethod: 'FBA', isActive: true }, select: { id: true } }).catch(() => null)
  const cl = await prisma.channelListing.findFirst({ where: { productId: k.id, channel: 'AMAZON', fulfillmentMethod: 'FBA' }, select: { id: true } })
  if ((fba._sum.quantity ?? 0) === 0 && !offer && !cl) safe.push(k.id)
  else console.log(`  HOLDING ${k.sku}: fbaStock=${fba._sum.quantity ?? 0} offer=${!!offer} listingFm=${!!cl}`)
}
console.log(`safe to flip: ${safe.length}`)
if (safe.length) {
  const u = await prisma.product.updateMany({ where: { id: { in: safe } }, data: { fulfillmentMethod: 'FBM' } })
  console.log(`flipped to FBM: ${u.count}`)
}
await prisma.$disconnect()
